# Task 13-b — MINDBEAT Client-Side Event Instrumentation

Agent: Z.ai Code (client instrumentation)
Status: COMPLETE — lint 0/0, tsc clean (own files), live browser QA passed.

## Files created
- `src/lib/mindbeat/client.ts` (NEW, ~600 lines) — the browser-side capture module:
  - **Kill switch**: `isEnabled()` = `localStorage['tsf-mindbeat-off'] !== 'on'`, checked per-enqueue; all capture no-ops when on.
  - **Session manager**: `tsf-mb-session` JSON `{id, lastTs}`; new ULID session + SESSION_START (payload `{daypart, dayKind}` via `currentDaypart()`) when absent or gapped > 30 min (`SESSION_GAP_MIN`); `lastTs` refreshed on every event; `getSessionId()` exposed; SSR-safe (`'ssr'` id on server).
  - **ULID**: tiny monotonic Crockford-base32 ULID (10-char ms timestamp + 80-bit crypto random, +1ms bump on same-ms).
  - **Batch queue**: module array; `enqueue` pushes + schedules a 5s trailing flush; immediate flush at cap; `flush()` POSTs `/api/mindbeat/ledger` `{events}` with `keepalive:true`; clears exactly the sent batch on 2xx, KEEPS everything (capped at 100, oldest dropped) on failure; also flushes on `visibilitychange→hidden` + `pagehide`.
  - **Constructors** (all return `LedgerEventIn`, id/ts/sessionId stamped): `trackStart, heartbeat, trackEnd, seek (2s throttle), like, unlike, download, queueAdd, queueRemove (auto-resolves wasRecommended from rec stamps), recExposure, searchQuery (1.5s per-identical-query dedup), searchClick, playlistSaveAi, aiRegenerate, notForMe, stationEnded, appBackground`.
  - **`trackEnd` → TRACK_SKIP conversion**: module TTL flag (5s) set by `notifyUserSkip()`; the next `trackEnd` within the window emits type `TRACK_SKIP` (same payload) and clears the flag — covers React effect-cleanup latency without leaking into later natural ends.
  - **Grading**: `gradeOf(listenedMs, durationMs)` per constitution (<5s INSTANT_REJECT; with duration: ≥95% COMPLETED → <30s EARLY_SKIP → ≥75% LATE_SKIP → else MID_SKIP; no duration: <30s EARLY_SKIP else MID_SKIP); `skipBucketOf(ratio)` = clamp(ceil(ratio·10),1,10).
  - **Context resolution**: `setPlaybackContext`/`getPlaybackContext` (default `user_queue`), `markQueueSource(tracks, surface, reasonCode?)` → Map stamp (TTL 24h, cap 500 FIFO-evict), `resolveTrackContext(videoId)` = stamp-wins-over-context; `surfaceForNavView(view)` helper for row menus.
  - **Heartbeats**: `startHeartbeats(getTrackId, getElapsedMs)` = 10s (`HEARTBEAT_SEC`) interval emitting `TRACK_HEARTBEAT` only when `getTrackId()` returns non-null; `stopHeartbeats()`.
  - Self-initializes on import (guarded `typeof window`): session ensure + flush listeners. No provider/AppShell wiring needed.

## Files modified (wiring points)
1. **`src/components/player/AudioEngine.tsx`** (additive only; listen-ms PATCH history flow untouched):
   - Static `import * as mb from '@/lib/mindbeat/client'` (the single init import).
   - New refs `currentTrackIdRef`, `trackCtxRef {id, ctx}`.
   - Track-change effect: resolve `startCtx` BEFORE `prevVideoIdRef` update; after `audio.load()` → `mb.trackStart(track, {surface, wasRecommended, reasonCode from startCtx, queuePosition, duration})` + `mb.startHeartbeats(() => isPlaying ? currentTrackIdRef.current : null, () => listenAccum + live segment)`.
   - Cleanup (same block as the leaving-track listen-ms PATCH): after computing `ms`, if `ms > 250` (StrictMode/double-mount noise floor; PATCH's own 1500ms gate untouched) → `mb.trackEnd(leavingId, {listenedMs, durationMs, grade: gradeOf, completionRatio, skipBucket, wasRecommended, reasonCode, surface from startCtx})`. Order guarantee: cleanup (leaving) runs BEFORE next body (trackStart), and `trackCtxRef` still holds the leaving track's context at that point.
   - Auto-skip sites now pass `{auto:true}`: watchdog dead-stream `s.next({auto:true})`, error auto-skip `s.next({auto:true})`, natural end `s.next({auto:true})` (natural end must grade TRACK_END, not TRACK_SKIP).
   - `seekTo()`: emits `mb.seek(trackId, fromMs, toMs)` (throttled 1/2s in client) before delegating to the store.
   - Audio-element effect ([] deps): `visibilitychange → appBackground()` only when `currentTrackIdRef` set; cleanup removes listener + `mb.stopHeartbeats()`.
2. **`src/store/player.ts`**:
   - `next`/`prev` signature → `(opts?: { auto?: boolean })`; user-initiated (no opts) lazily `import('@/lib/mindbeat/client').then(m => m.notifyUserSkip())` BEFORE the state change (prev: only in the actual track-change branch; the restart-at->3s path is not a skip).
   - `applySmartShuffle`: stamps ONLY `insertedAt` slots → `markQueueSource(recs, 'smart_shuffle_rec')` (lazy import).
   - `addToQueue`/`playNext` → `queueAdd(videoId,'user_queue')`; `removeFromQueue` → `queueRemove(videoId)` (wasRecommended resolved from stamps inside client).
3. **`src/store/library.ts`**: `toggleLike` success path → `unlike()` / `like(videoId, artistId, artistName, getPlaybackContext().surface)`.
4. **`src/components/views/SearchView.tsx`**: settled-query `.then` → `searchQuery(debounced, tracks.length)` (client-side 1.5s identical-query dedup); both rendered row lists ('all' top-4 + 'songs' full) → `searchClick(videoId, i)` in `onPlay` (rank = rendered index).
5. **`src/components/views/AiGeneratedView.tsx`**: new effect on `[data, endpoint]` → `markQueueSource(tracks, surface)` + per-track `recExposure(videoId, surface, rank)`. Endpoint→surface map: discover-weekly/release-radar→`discovery`, daylist→`daylist`, on-repeat→`daily_mix`, else `ai_playlist`.
6. **`src/components/views/PlaylistView.tsx`**: when fetched playlist has `source === 'ai'` (AI generator sets source:'ai' — verified in `/api/ai/playlist-generator/route.ts` lines 174/226) → `markQueueSource(pl.tracks, 'ai_playlist', 'FROM_YOUR_AI_MIX')`. This covers the generator's "Open playlist" play path.
7. **`src/components/player/TrackContextMenu.tsx`**: new **"Not for me"** menu item (Ban icon, after Copy song link, own separator) → `notForMe(videoId, surfaceForNavView(view))` + sonner toast ("Okay — we'll play less {artist}"); `onDownload` success → `download(videoId)`.
8. **Type-fallout fixes (required to compile my signature change)**: `FullScreenNowPlaying.tsx` + `NowPlayingBar.tsx` — wrapped bare `onClick={next}` / `onClick={prev}` as `onClick={() => next()}` etc. (React would have passed the MouseEvent as `opts`). No behavior change.

## Verification
- `bun run lint` → 0 problems. `bunx tsc --noEmit` → ZERO errors in my files (remaining errors: `src/lib/mindbeat/ledger.ts` = agent 13-a's file, plus pre-existing examples/skills/tsf-analysis noise).
- Live QA (agent-browser, localhost:3000): home renders; clicked a quick pick → `isPlaying:true`; `next()` user-skip OK; **4× `POST /api/mindbeat/ledger` observed in network log** (session flush + trailing flushes + post-skip flush) — 404 because agent 13-a's route isn't merged yet (client keeps + caps events on failure, as designed); `localStorage['tsf-mb-session']` = valid 26-char ULID with fresh lastTs; **0 console errors/warnings, 0 page errors**.
- dev.log: page loads 200, only expected `POST /api/mindbeat/ledger 404` lines.

## Handoff notes for 13-a / next agents
- Route contract consumed by the client: `POST /api/mindbeat/ledger` body `{ events: LedgerEventIn[] }` (id, ts ISO, type, sessionId, trackId?, artistId?, artistName?, surface?, payload?) — reply 2xx to ack; anything non-2xx makes clients retry-with-cap. Batch size ≤100 per POST.
- `NOT_FOR_ME` carries `surface` from the nav view; `QUEUE_REMOVE.wasRecommended` is auto-resolved from rec-source stamps server-side can trust it.
- Skipped (out of scope / no clean point): PLAYLIST_SAVE_AI + AI_REGENERATE emission (generator has no explicit save/regenerate action to hook — "Make another" just clears state), STATION_ENDED (radio has no end-of-station hook), download() in NowPlayingBar/FullScreenNowPlaying mini download buttons (context-menu path wired as the canonical one). All constructors exist and are ready.
