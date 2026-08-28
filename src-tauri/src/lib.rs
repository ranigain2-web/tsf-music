//! TSF Music — native desktop shell (Tauri 2 / WKWebView).
//!
//! ARCHITECTURE (the "native-at-least" bar):
//!   - This Rust binary IS the app: it boots the bundled playback engine
//!     (Next standalone server run by a bundled Bun runtime) and the POT
//!     provider (yt-dlp proof-of-origin token minter) as child processes,
//!     waits for health, then points a native WKWebView window at it.
//!   - Everything user-visible (window, menu bar, dock menu, tray, media
//!     keys, lockscreen Now Playing) is handled natively here:
//!       * Now Playing / media keys via `souvlaki` (MPNowPlayingInfoCenter +
//!         MPRemoteCommandCenter on macOS).
//!       * Native menu bar with a Playback section, dock menu, menu-bar tray
//!         — all dispatching into the page as CustomEvents.
//!       * Web → native: `media_update` IPC command (metadata / playback state).
//!       * Native → web: `tsf-media-command` / `tsf-ui-command` CustomEvents.
//!   - App Nap is disabled in Info.plist (`NSAppSleepDisabled`) so audio keeps
//!     playing when the window is hidden/minimized.
//!   - Boot failure is recoverable from the UI: the fallback page's Retry
//!     button invokes `boot_retry`, which kills stale children and boots again.

use serde_json::json;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// Child processes owned by the shell; killed on app exit.
pub struct ChildProcs {
    pub pot: Mutex<Option<Child>>,
    pub server: Mutex<Option<Child>>,
    pub port: Mutex<u16>,
}

/// `souvlaki::MediaControls` wraps platform objects (objc ids on macOS) that
/// are not `Send` by auto-trait, but Apple's APIs we touch are documented
/// main-thread-only — and we funnel EVERY call through
/// `run_on_main_thread`. So a manual Send/Sync here is sound and lets the
/// controls live in Tauri-managed state.
pub struct MediaCell(pub Mutex<Option<MediaControls>>);
unsafe impl Send for MediaCell {}
unsafe impl Sync for MediaCell {}

pub struct MediaState {
    pub controls: MediaCell,
}

/// Guards boot so the Retry button can't double-spawn the engine.
static BOOTING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Small TCP helpers (no HTTP client dep — the shell stays tiny)
// ---------------------------------------------------------------------------

fn find_free_port(start: u16, tries: u8) -> u16 {
    for i in 0..tries {
        let p = start + i;
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    start
}

/// Any parseable HTTP response = something is listening.
fn http_alive(addr: &str, path: &str) -> bool {
    (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect(addr)?;
        s.set_read_timeout(Some(Duration::from_millis(1200)))?;
        s.set_write_timeout(Some(Duration::from_millis(1200)))?;
        write!(s, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")?;
        let mut buf = [0u8; 16];
        let n = s.read(&mut buf)?;
        Ok(n >= 12 && buf.starts_with(b"HTTP/1."))
    })()
    .unwrap_or(false)
}

/// Strict: 2xx only (used for /api/health).
fn http_ok(addr: &str, path: &str) -> bool {
    (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect(addr)?;
        s.set_read_timeout(Some(Duration::from_millis(1500)))?;
        s.set_write_timeout(Some(Duration::from_millis(1500)))?;
        write!(s, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")?;
        let mut buf = [0u8; 16];
        let n = s.read(&mut buf)?;
        Ok(n >= 12 && buf.starts_with(b"HTTP/1.") && buf[9] == b'2')
    })()
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Resource / logging helpers
// ---------------------------------------------------------------------------

fn res(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|d| d.join(rel))
        .map_err(|e| format!("resource_dir: {e}"))
}

fn log_stdio(app: &AppHandle, name: &str) -> Result<Stdio, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir logs: {e}"))?;
    let f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{name}.log")))
        .map_err(|e| format!("open log: {e}"))?;
    Ok(Stdio::from(f))
}

// ---------------------------------------------------------------------------
// Native → web dispatch (one funnel for souvlaki, menu, dock, tray)
// ---------------------------------------------------------------------------

fn post_media_command(app: &AppHandle, detail: serde_json::Value) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(&format!(
            "window.dispatchEvent(new CustomEvent('tsf-media-command', {{ detail: {detail} }}))"
        ));
    }
}

fn post_ui_command(app: &AppHandle, action: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let detail = json!({ "action": action });
        let _ = win.eval(&format!(
            "window.dispatchEvent(new CustomEvent('tsf-ui-command', {{ detail: {detail} }}))"
        ));
    }
}

fn reload_page(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("location.reload()");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Service boot
// ---------------------------------------------------------------------------

struct BootOutcome {
    ok: bool,
    port: u16,
    error: String,
}

fn boot_services(app: &AppHandle) -> BootOutcome {
    match boot_services_inner(app) {
        Ok(port) => BootOutcome { ok: true, port, error: String::new() },
        Err(e) => BootOutcome { ok: false, port: 0, error: e },
    }
}

fn boot_status(win: Option<&WebviewWindow>, msg: &str) {
    if let Some(win) = win {
        let detail = json!({ "text": msg });
        let _ = win.eval(&format!(
            "window.dispatchEvent(new CustomEvent('tsf-boot-status', {{ detail: {detail} }}))"
        ));
    }
}

fn kill_children(app: &AppHandle) {
    let st = app.state::<ChildProcs>();
    if let Some(mut p) = st.server.lock().unwrap().take() {
        let _ = p.kill();
        let _ = p.wait();
    }
    if let Some(mut p) = st.pot.lock().unwrap().take() {
        let _ = p.kill();
        let _ = p.wait();
    }
}

fn boot_services_inner(app: &AppHandle, win: Option<&WebviewWindow>) -> Result<u16, String> {
    boot_status(win, "Preparing the local engine…");

    let runtime_bun = res(app, "resources/runtime/bun")?;
    let server_dir = res(app, "resources/server")?;
    let pot_dir = res(app, "resources/pot-provider")?;
    let bin_dir = res(app, "resources/bin")?;
    let db_res = res(app, "resources/db/tsf.db")?;

    #[cfg(unix)]
    for p in [&runtime_bun, &bin_dir.join("yt-dlp")] {
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("mkdir app-data: {e}"))?;
    let db_path = app_data.join("tsf.db");
    if !db_path.exists() {
        std::fs::copy(&db_res, &db_path).map_err(|e| format!("copy db: {e}"))?;
    }

    let port = find_free_port(8137, 12);
    let pot_port = find_free_port(4416, 8);
    let path_var =
        format!("{}:{}", bin_dir.display(), std::env::var("PATH").unwrap_or_default());

    // --- POT provider (BotGuard proof-of-origin tokens for yt-dlp) -----------
    boot_status(win, "Starting the playback-token service…");
    let pot = Command::new(&runtime_bun)
        .arg(pot_dir.join("index.js"))
        .current_dir(&pot_dir)
        .env("PORT", pot_port.to_string())
        .env("PATH", &path_var)
        .stdout(log_stdio(app, "pot-provider")?)
        .stderr(log_stdio(app, "pot-provider")?)
        .spawn()
        .map_err(|e| format!("spawn pot-provider: {e}"))?;

    // Best-effort wait: yt-dlp retries token minting internally, so failing
    // this wait must not abort boot.
    let pot_addr = format!("127.0.0.1:{pot_port}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !http_alive(&pot_addr, "/get_capabilities") {
        std::thread::sleep(Duration::from_millis(200));
    }

    // --- Next standalone server (the whole TSF Music engine) ----------------
    boot_status(win, "Starting the music engine…");
    let resource_root = res(app, "")?;
    let server = Command::new(&runtime_bun)
        .arg(server_dir.join("server.js"))
        .current_dir(&server_dir)
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("TSF_POT_URL", format!("http://127.0.0.1:{pot_port}"))
        .env("TSF_RESOURCES", resource_root.display().to_string())
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("PATH", &path_var)
        .stdout(log_stdio(app, "server")?)
        .stderr(log_stdio(app, "server")?)
        .spawn()
        .map_err(|e| format!("spawn server: {e}"))?;

    {
        let st = app.state::<ChildProcs>();
        *st.pot.lock().unwrap() = Some(pot);
        *st.server.lock().unwrap() = Some(server);
        *st.port.lock().unwrap() = port;
    }

    boot_status(win, "Warming up your library…");
    let addr = format!("127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if http_ok(&addr, "/api/health") {
            return Ok(port);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("engine did not become healthy within 120s (see ~/Library/Logs/com.tsfmusic.desktop)".into())
}

fn boot_task(app: AppHandle) {
    if BOOTING.swap(true, Ordering::SeqCst) {
        return; // a boot is already in flight
    }
    let win = app.get_webview_window("main");
    kill_children(&app);
    let outcome = boot_services(&app);
    if outcome.ok {
        if let Some(win) = win.as_ref() {
            boot_status(Some(win), "Opening your library…");
        }
        if let Some(win) = win {
            let _ =
                win.eval(&format!("location.replace('http://127.0.0.1:{}/')", outcome.port));
        }
    } else {
        let msg = outcome.error.replace(['\'', '"', '\\'], "");
        if let Some(win) = win {
            let _ = win.eval(&format!(
                "window.dispatchEvent(new CustomEvent('tsf-boot-error', {{ detail: '{msg}' }}))"
            ));
        }
    }
    BOOTING.store(false, Ordering::SeqCst);
}

/// Fallback-page Retry button → kill stale children and boot again.
#[tauri::command]
fn boot_retry(app: AppHandle) {
    show_main(&app);
    std::thread::spawn(move || boot_task(app));
}

// ---------------------------------------------------------------------------
// Native media controls (Now Playing + media keys)
// ---------------------------------------------------------------------------

fn forward_media_event(app: &AppHandle, ev: MediaControlEvent) {
    let detail = match ev {
        MediaControlEvent::Play => json!({"type": "play"}),
        MediaControlEvent::Pause => json!({"type": "pause"}),
        MediaControlEvent::Toggle => json!({"type": "toggle"}),
        MediaControlEvent::Next => json!({"type": "next"}),
        MediaControlEvent::Previous => json!({"type": "previous"}),
        MediaControlEvent::Stop => json!({"type": "stop"}),
        MediaControlEvent::SetPosition(pos) => {
            json!({"type": "seekto", "seconds": pos.0.as_secs_f64()})
        }
        MediaControlEvent::SeekBy(dir, d) => json!({
            "type": "seekby",
            "dir": if matches!(dir, SeekDirection::Forward) { "forward" } else { "backward" },
            "seconds": d.as_secs_f64()
        }),
        MediaControlEvent::SetVolume(v) => json!({"type": "volume", "volume": v}),
        _ => return,
    };
    post_media_command(app, detail);
}

fn init_media_controls(app: &AppHandle) {
    let config =
        PlatformConfig { dbus_name: "tsf-music", display_name: "TSF Music", hwnd: None };
    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(_) => return,
    };
    let h = app.clone();
    let _ = controls.attach(move |ev: MediaControlEvent| forward_media_event(&h, ev));
    if let Ok(mut guard) = app.state::<MediaState>().controls.0.lock() {
        *guard = Some(controls);
    }
}

/// Web → native IPC. The web UI sends playback metadata/state; we project it
/// onto the OS Now Playing surface (lockscreen / Control Center / media keys).
#[tauri::command]
fn media_update(app: AppHandle, cmd: String, payload: serde_json::Value) {
    // NOTE: `app` is used twice (moved into the closure AND for
    // run_on_main_thread) — clone first or this is E0382.
    let app_in = app.clone();
    let run = move || {
        let state = app_in.state::<MediaState>();
        let mut guard = match state.controls.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(controls) = guard.as_mut() else { return };
        match cmd.as_str() {
            "metadata" => {
                let duration = payload
                    .get("duration")
                    .and_then(|v| v.as_f64())
                    .filter(|d| *d > 0.0)
                    .map(Duration::from_secs_f64);
                let m = MediaMetadata {
                    title: payload.get("title").and_then(|v| v.as_str()),
                    artist: payload.get("artist").and_then(|v| v.as_str()),
                    album: payload.get("album").and_then(|v| v.as_str()),
                    cover_url: payload.get("artworkUrl").and_then(|v| v.as_str()),
                    duration,
                };
                let _ = controls.set_metadata(m);
            }
            "state" => {
                let playing =
                    payload.get("playing").and_then(|v| v.as_bool()).unwrap_or(false);
                let progress = payload
                    .get("position")
                    .and_then(|v| v.as_f64())
                    .map(|s| MediaPosition(Duration::from_secs_f64(s.max(0.0))));
                let playback = if playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                };
                let _ = controls.set_playback(playback);
            }
            "stop" => {
                let _ = controls.set_playback(MediaPlayback::Stopped);
            }
            _ => {}
        }
    };
    let _ = app.run_on_main_thread(run);
}

// ---------------------------------------------------------------------------
// Native menu bar + dock menu + tray
// ---------------------------------------------------------------------------

/// Menu-bar ids → the same CustomEvent funnel the media keys use, so ONE web
/// handler serves menu bar, dock, tray, headphones and lockscreen.
fn handle_action_id(app: &AppHandle, id: &str) {
    match id {
        "tsf:playpause" => post_media_command(app, json!({"type": "toggle"})),
        "tsf:next" => post_media_command(app, json!({"type": "next"})),
        "tsf:previous" => post_media_command(app, json!({"type": "previous"})),
        "tsf:stop" => post_media_command(app, json!({"type": "stop"})),
        "tsf:seekback" => {
            post_media_command(app, json!({"type": "seekby", "dir": "backward", "seconds": 10.0}))
        }
        "tsf:seekforward" => {
            post_media_command(app, json!({"type": "seekby", "dir": "forward", "seconds": 10.0}))
        }
        "tsf:volup" => post_media_command(app, json!({"type": "voldelta", "delta": 0.05})),
        "tsf:voldown" => post_media_command(app, json!({"type": "voldelta", "delta": -0.05})),
        "tsf:lyrics" => post_ui_command(app, "toggle-lyrics"),
        "tsf:queue" => post_ui_command(app, "open-queue"),
        "tsf:reload" => reload_page(app),
        "tsf:show" => show_main(app),
        "tsf:retry" => {
            show_main(app);
            let h = app.clone();
            std::thread::spawn(move || boot_task(h));
        }
        _ => {}
    }
}

fn build_menus(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // -- App menu (first submenu becomes the macOS app menu) -----------------
    let app_sub = Submenu::new(app, "TSF Music", true)?;
    app_sub.append(&PredefinedMenuItem::about(
        app,
        Some("About TSF Music"),
        Some("AI music player with full-length streaming — every feature, 100% local."),
    )?)?;
    app_sub.append(&PredefinedMenuItem::separator(app)?)?;
    app_sub.append(&PredefinedMenuItem::services(app)?)?;
    app_sub.append(&PredefinedMenuItem::separator(app)?)?;
    app_sub.append(&PredefinedMenuItem::hide(app)?)?;
    app_sub.append(&PredefinedMenuItem::hide_others(app)?)?;
    app_sub.append(&PredefinedMenuItem::show_all(app)?)?;
    app_sub.append(&PredefinedMenuItem::separator(app)?)?;
    app_sub.append(&PredefinedMenuItem::quit(app)?)?;

    // -- File ----------------------------------------------------------------
    let file_sub = Submenu::new(app, "File", true)?;
    file_sub.append(&PredefinedMenuItem::close_window(app)?)?;

    // -- Edit (copy/paste — REQUIRED for search fields) ----------------------
    let edit_sub = Submenu::new(app, "Edit", true)?;
    edit_sub.append(&PredefinedMenuItem::undo(app)?)?;
    edit_sub.append(&PredefinedMenuItem::redo(app)?)?;
    edit_sub.append(&PredefinedMenuItem::separator(app)?)?;
    edit_sub.append(&PredefinedMenuItem::cut(app)?)?;
    edit_sub.append(&PredefinedMenuItem::copy(app)?)?;
    edit_sub.append(&PredefinedMenuItem::paste(app)?)?;
    edit_sub.append(&PredefinedMenuItem::select_all(app)?)?;

    // -- View ----------------------------------------------------------------
    let view_sub = Submenu::new(app, "View", true)?;
    view_sub.append(&MenuItem::with_id(
        app,
        "tsf:reload",
        "Reload",
        true,
        Some("CmdOrCtrl+R"),
    )?)?;
    view_sub.append(&PredefinedMenuItem::fullscreen(app)?)?;
    view_sub.append(&PredefinedMenuItem::separator(app)?)?;
    view_sub.append(&MenuItem::with_id(
        app,
        "tsf:lyrics",
        "Lyrics",
        true,
        Some("Alt+CmdOrCtrl+L"),
    )?)?;
    view_sub.append(&MenuItem::with_id(
        app,
        "tsf:queue",
        "Queue",
        true,
        Some("Alt+CmdOrCtrl+Q"),
    )?)?;

    // -- Playback (the Spotify-desktop signature menu) ------------------------
    let play_sub = Submenu::new(app, "Playback", true)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:playpause",
        "Play/Pause",
        true,
        Some("Alt+CmdOrCtrl+P"),
    )?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:next",
        "Next",
        true,
        Some("Alt+CmdOrCtrl+Right"),
    )?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:previous",
        "Previous",
        true,
        Some("Alt+CmdOrCtrl+Left"),
    )?)?;
    play_sub.append(&MenuItem::with_id(app, "tsf:stop", "Stop", true, None::<&str>)?)?;
    play_sub.append(&PredefinedMenuItem::separator(app)?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:seekback",
        "Seek Back 10s",
        true,
        None::<&str>,
    )?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:seekforward",
        "Seek Forward 10s",
        true,
        None::<&str>,
    )?)?;
    play_sub.append(&PredefinedMenuItem::separator(app)?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:volup",
        "Volume Up",
        true,
        Some("Alt+CmdOrCtrl+Up"),
    )?)?;
    play_sub.append(&MenuItem::with_id(
        app,
        "tsf:voldown",
        "Volume Down",
        true,
        Some("Alt+CmdOrCtrl+Down"),
    )?)?;

    // -- Window ---------------------------------------------------------------
    let window_sub = Submenu::new(app, "Window", true)?;
    window_sub.append(&PredefinedMenuItem::minimize(app)?)?;
    window_sub.append(&PredefinedMenuItem::maximize(app)?)?;
    window_sub.append(&PredefinedMenuItem::separator(app)?)?;
    window_sub.append(&PredefinedMenuItem::bring_all_to_front(app)?)?;

    let menu = Menu::new(app)?;
    menu.append(&app_sub)?;
    menu.append(&file_sub)?;
    menu.append(&edit_sub)?;
    menu.append(&view_sub)?;
    menu.append(&play_sub)?;
    menu.append(&window_sub)?;
    Ok(menu)
}

/// Dock menu (macOS right-click on the Dock icon).
#[cfg(target_os = "macos")]
fn build_dock_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    let dock = MenuBuilder::new(app)
        .item(&MenuItem::with_id(app, "tsf:show", "Show TSF Music", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "tsf:playpause", "Play/Pause", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "tsf:next", "Next", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "tsf:previous", "Previous", true, None::<&str>)?)
        .build()?;
    app.set_dock_menu(&dock)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn build_dock_menu(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// Menu-bar tray with quick transport controls (right-click menu; left-click
/// focuses the app window).
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let tray_menu = Menu::new(app)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tsf:show",
        "Show TSF Music",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&PredefinedMenuItem::separator(app)?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tsf:playpause",
        "Play/Pause",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&MenuItem::with_id(app, "tsf:next", "Next", true, None::<&str>)?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tsf:previous",
        "Previous",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&PredefinedMenuItem::separator(app)?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tsf:retry",
        "Restart Engine…",
        true,
        None::<&str>,
    )?)?;

    TrayIconBuilder::with_id("tsf-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
        .tooltip("TSF Music")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_action_id(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .manage(ChildProcs {
            pot: Mutex::new(None),
            server: Mutex::new(None),
            port: Mutex::new(0),
        })
        .manage(MediaState { controls: MediaCell(Mutex::new(None)) })
        .invoke_handler(tauri::generate_handler![media_update, boot_retry])
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) Native menu bar (App/File/Edit/View/Playback/Window).
            let menu = build_menus(app)?;
            app.set_menu(menu)?;

            // 2) Dock menu + tray.
            build_dock_menu(&handle)?;
            build_tray(&handle)?;

            // 3) Loading window immediately (served from the bundled fallback
            //    page — dark, TSF-styled) so the user never sees a blank dock.
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("TSF Music")
                .inner_size(1200.0, 800.0)
                .min_inner_size(980.0, 640.0)
                .center()
                .theme(Theme::Dark)
                .build()?;

            // 4) Now Playing / media keys — init on the main thread (setup runs
            //    there; MPRemoteCommandCenter requires it).
            init_media_controls(&handle);

            // 5) Menu events → the single action funnel.
            handle.on_menu_event(move |app, event| handle_action_id(app, event.id().as_ref()));

            // 6) Boot engine + POT provider in the background, then navigate.
            std::thread::spawn(move || boot_task(handle));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_children(app);
            }
        });
}
