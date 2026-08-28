#!/usr/bin/env python3
"""
TSF Music v3 — self-contained E2E gauntlet.
Starts the dev server, runs the full validation matrix in-process, kills it.
Verifies: JioSaavn full-length E2E, honest previews, cache-precedence fix
(the preview-shadowing bug), preview purge on upgrade, Range/proxy mechanics,
malformed-id guards, cache-hit latency, health metrics.
"""
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
import sqlite3
import os

BASE = "http://localhost:3000"
PROJECT = "/home/z/my-project"
DB = f"{PROJECT}/db/custom.db"
RESULTS = []

def req(url, method="GET", headers=None, timeout=40):
    r = urllib.request.Request(url, method=method, headers=headers or {})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), time.time() - t0
    except Exception as e:
        return 0, {"error": str(e)}, time.time() - t0

def get_body(url, timeout=60, headers=None):
    r = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, b"", dict(e.headers)
    except Exception as e:
        return 0, str(e).encode(), {}

def record(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}")

def db_exec(sql, params=()):
    con = sqlite3.connect(DB)
    cur = con.execute(sql, params)
    rows = cur.fetchall()
    con.commit()
    con.close()
    return rows

def main():
    # ---- boot ----
    print("booting dev server...")
    env = dict(os.environ)
    proc = subprocess.Popen(
        ["bun", "run", "dev"], cwd=PROJECT, env=env,
        stdout=open(f"{PROJECT}/dev.log", "w"), stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(60):
            time.sleep(2)
            code, _, _ = req(f"{BASE}/api/health", timeout=5)
            if code == 200:
                print("server ready")
                break
        else:
            print("SERVER FAILED TO BOOT — dev.log tail:")
            print(open(f"{PROJECT}/dev.log").read()[-2000:])
            sys.exit(1)
        time.sleep(2)

        # ---- 1. JioSaavn full-length matrix (through the app) ----
        matrix = [
            ("Kesariya", "NJAv_7lHUIU", "Kesariya", "Arijit Singh", 269, 268),
            ("Tum Hi Ho", "fsiPzT50ZiM", "Tum Hi Ho", "Arijit Singh", 262, 261),
            ("Mere Sapnon Ki Rani", "RVeLrwoB_xw", "Mere Sapnon Ki Rani", "Kishore Kumar", 301, 300),
            ("Naatu Naatu", "AbaAxgufFA8", "Naatu Naatu", "Rahul Sipligung", 215, 214),
            ("Brown Munde", "FM2ykrYbzqg", "Brown Munde", "AP Dhillon", 255, 254),
        ]
        for name, vid, title, artist, dur, expect_dur in matrix:
            url = f"{BASE}/api/stream?id={vid}&title={urllib.parse.quote(title)}&artist={urllib.parse.quote(artist)}&dur={dur}"
            code, headers, t = req(url, method="HEAD")
            prov = headers.get("x-stream-provider", "")
            br = headers.get("x-stream-bitrate", "")
            art = headers.get("x-stream-art", "")
            ok = code == 200 and prov == "jiosaavn"
            record(f"jiosaavn-resolve[{name}]", ok,
                   f"HEAD {code} provider={prov} bitrate={br} art={'yes' if art else 'no'} {t:.2f}s")
            if not ok:
                continue
            # follow the redirect and verify REAL audio bytes + duration
            code2, _, _ = req(url)  # GET → 307 (Location auto-not followed by urllib? it DOES follow)
            # urllib follows redirects; fetch a range of bytes to prove liveness
            code3, body, h3 = get_body(f"{url}&proxy=1", timeout=90,
                                       headers={"Range": "bytes=0-99999"})
            size = len(body)
            dur_ok = False
            if size >= 99900:
                # download fully and ffprobe
                code4, full, h4 = get_body(f"{url}&proxy=1", timeout=180)
                with open("/tmp/track.mp4", "wb") as f:
                    f.write(full)
                p = subprocess.run(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration,bit_rate",
                     "-of", "json", "/tmp/track.mp4"], capture_output=True, text=True)
                try:
                    meta = json.loads(p.stdout)["format"]
                    got = float(meta["duration"])
                    dur_ok = abs(got - expect_dur) <= max(4, expect_dur * 0.03)
                    record(f"full-length-real-audio[{name}]", dur_ok and len(full) > 1_000_000,
                           f"ffprobe dur={got:.1f}s (expect ~{expect_dur}) bitrate={int(meta.get('bit_rate',0))//1000}kbps bytes={len(full):,}")
                except Exception as e:
                    record(f"full-length-real-audio[{name}]", False, f"ffprobe failed: {e}")
            else:
                record(f"full-length-real-audio[{name}]", False, f"proxy bytes too small: {size}")

        # ---- 2. International from datacenter → honest preview ----
        url = f"{BASE}/api/stream?id=4NRXx6U8ABQ&title=Blinding%20Lights&artist=The%20Weeknd&dur=202"
        code, headers, t = req(url, method="HEAD")
        prov = headers.get("x-stream-provider", "")
        ok = code == 200 and prov in ("itunes-preview",)
        record("intl-preview-honest", ok, f"HEAD {code} provider={prov} (yt-dlp absent here; on Mac it wins) {t:.2f}s")

        # ---- 3. THE CACHE-PRECEDENCE FIX (the reported bug) ----
        # Simulate the exact field condition: a title-scoped itunes-preview row
        # for the SAME videoId that has a full-length row.
        vid = "4NRXx6U8ABQ"
        rows = db_exec("SELECT videoId, provider FROM StreamCache WHERE videoId LIKE ?", (vid + "%",))
        record("cache-state-before", any(r[1] == "itunes-preview" for r in rows), f"rows={rows}")
        # insert a fake full-length row under the bare key (as yt-dlp would)
        db_exec(
            "INSERT OR REPLACE INTO StreamCache (videoId, url, provider, expiresAt, bitrate) VALUES (?,?,?,?,?)",
            (vid, "https://aac.saavncdn.com/871/c2febd353f3a076a406fa37510f31f9f_320.mp4",
             "yt-dlp", "2026-12-01 00:00:00", 128000))
        code, headers, t = req(url, method="HEAD")  # same title-scoped query as before
        prov = headers.get("x-stream-provider", "")
        ok = prov == "yt-dlp"
        record("CACHE-PRECEDENCE-FIX (full-length beats preview)", ok,
               f"lookup with preview row present returned provider={prov} {t:.3f}s")

        # ---- 4. Preview purge on upgrade ----
        db_exec("DELETE FROM StreamCache WHERE videoId LIKE ?", (vid + "%",))
        db_exec(
            "INSERT INTO StreamCache (videoId, url, provider, expiresAt, bitrate) VALUES (?,?,?,?,?)",
            (vid + "::deadbeef", "https://audio-ssl.itunes.apple.com/x.m4a", "itunes-preview",
             "2026-12-01 00:00:00", 96000))
        # force a fresh resolve that lands jiosaavn... use Kesariya's vid instead for a real full-length landing
        kurl = f"{BASE}/api/stream?id=NJAv_7lHUIU&title=Kesariya&artist=Arijit%20Singh&dur=269&fresh=1"
        code, headers, t = req(kurl, method="HEAD")
        rows = db_exec("SELECT provider FROM StreamCache WHERE videoId LIKE 'NJAv_7lHUIU%'")
        record("full-length-lands-when-fresh", code == 200 and any(r[0] == "jiosaavn" for r in rows),
               f"fresh resolve {code} rows={[r[0] for r in rows]}")
        # now the jiosaavn result should have PURGED no preview (none existed) — but test the purge path:
        db_exec(
            "INSERT INTO StreamCache (videoId, url, provider, expiresAt, bitrate) VALUES (?,?,?,?,?)",
            ("NJAv_7lHUIU::zzpreview", "https://audio-ssl.itunes.apple.com/y.m4a", "itunes-preview",
             "2026-12-01 00:00:00", 96000))
        code, headers, t = req(kurl)  # cached jiosaavn lookup + (no new write since cache hit) — insert purge test via fresh
        code, headers, t = req(kurl + "&x=1", method="HEAD")
        # fresh=1 → resolveStream skipCache → jiosaavn lands → cacheResult purges preview rows
        rows = db_exec("SELECT provider FROM StreamCache WHERE videoId LIKE 'NJAv_7lHUIU%'")
        ok = not any(r[0] == "itunes-preview" for r in rows)
        record("PREVIEW-PURGE-ON-UPGRADE", ok, f"rows after full-length resolve={[r[0] for r in rows]}")

        # ---- 5. Guards ----
        code, _, _ = req(f"{BASE}/api/stream?id=**bad-id**")
        record("malformed-id-400", code == 400, f"code={code}")
        code, _, _ = req(f"{BASE}/api/stream")
        record("missing-id-400", code == 400, f"code={code}")

        # ---- 6. Range/proxy mechanics ----
        kurl2 = f"{BASE}/api/stream?id=NJAv_7lHUIU&title=Kesariya&artist=Arijit%20Singh&dur=269&proxy=1"
        r = urllib.request.Request(kurl2, headers={"Range": "bytes=0-999"})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                code, hdrs = resp.status, dict(resp.headers)
                resp.read(2000)
        except urllib.error.HTTPError as e:
            code, hdrs = e.code, dict(e.headers)
        record("range-206", code == 206 and "content-range" in {k.lower() for k in hdrs},
               f"code={code} content-range={hdrs.get('Content-Range', hdrs.get('content-range', 'MISSING'))}")

        # mid-song seek
        r = urllib.request.Request(kurl2, headers={"Range": "bytes=5000000-5000999"})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                code, hdrs, body = resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            code, hdrs, body = e.code, dict(e.headers), b""
        record("mid-song-seek-206", code == 206 and len(body) == 1000,
               f"code={code} bytes={len(body)}")

        # ---- 7. cache-hit latency ----
        t0 = time.time()
        code, headers, t = req(f"{BASE}/api/stream?id=NJAv_7lHUIU&title=Kesariya&artist=Arijit%20Singh&dur=269", method="HEAD")
        record("cache-hit-fast", code == 200 and t < 1.0, f"{t*1000:.0f}ms provider={headers.get('x-stream-provider')}")

        # ---- 8. health metrics ----
        code, body, _ = get_body(f"{BASE}/api/health")
        try:
            j = json.loads(body)
            m = j["resolveMetrics"]
            record("health-metrics-live", m["total"] > 0, f"total={m['total']} okRate={m['okRate']}% p50={m['p50']}ms")
            record("health-ytdlp-block", "ytdlp" in j, f"ytdlp={j.get('ytdlp')}")
        except Exception as e:
            record("health-metrics-live", False, str(e))

        # ---- 9. download route ----
        code, body, h = get_body(f"{BASE}/api/download?id=NJAv_7lHUIU&title=Kesariya&artist=Arijit%20Singh&dur=269", timeout=120)
        record("download-real-bytes", code == 200 and len(body) > 1_000_000,
               f"code={code} bytes={len(body):,} provider={h.get('x-stream-provider')}")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        subprocess.run(["pkill", "-f", "next dev"], capture_output=True)

    # ---- summary ----
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 60)
    print(f"RESULTS: {passed}/{len(RESULTS)} PASS")
    print("=" * 60)
    fails = [(n, d) for n, ok, d in RESULTS if not ok]
    if fails:
        print("FAILURES:")
        for n, d in fails:
            print(f"  - {n}: {d}")
    with open("/tmp/gauntlet-results.json", "w") as f:
        json.dump([{"name": n, "ok": ok, "detail": d} for n, ok, d in RESULTS], f, indent=1)
    return 0 if passed == len(RESULTS) else 1

if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
