#!/usr/bin/env python3
"""
JioSaavn international catalog depth test: do ORIGINALS exist?
For each query, list top-10 results (title | artist | dur) and check if the
expected original artist appears. Then verify the original streams full-length.
"""
import json, subprocess, urllib.request, urllib.parse, base64, re, os, tempfile
from Crypto.Cipher import DES

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def http(url, headers=None, timeout=10, max_bytes=None):
    h = {"User-Agent": UA, "Accept": "*/*", "Referer": "https://www.jiosaavn.com/"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), (r.read(max_bytes) if max_bytes else r.read())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:500]
    except Exception as e:
        return 0, {}, str(e).encode()[:200]

def des_decrypt(b64s):
    s = b64s + "=" * (-len(b64s) % 4)
    out = DES.new(b"38346591", DES.MODE_ECB).decrypt(base64.b64decode(s)).decode("utf-8", "replace")
    return re.sub(r"[\x00-\x08\x0b-\x1f]+$", "", out).strip()

def search(q, n=10):
    qq = urllib.parse.quote(q)
    st, hd, body = http(f"https://www.jiosaavn.com/api.php?_format=json&__call=search.getResults&q={qq}&p=1&n={n}&_marker=0&api_version=4&ctx=web6dot0", timeout=10)
    if st != 200: return []
    txt = body.decode("utf-8", "replace").replace('/*"}', "", 1)
    try: return json.loads(txt).get("results") or []
    except Exception: return []

def fp(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration,bit_rate", "-of", "json", path],
                             capture_output=True, text=True, timeout=20)
        d = json.loads(out.stdout)["format"]
        return float(d["duration"]), d.get("bit_rate", "?")
    except Exception: return 0.0, "?"

TESTS = [
    ("shape of you", "ed sheeran"),
    ("perfect", "ed sheeran"),
    ("bad guy", "billie eilish"),
    ("blinding lights", "the weeknd"),
    ("believer", "imagine dragons"),
    ("faded", "alan walker"),
    ("someone like you", "adele"),
    ("closer", "the chainsmokers"),
    ("unstoppable", "sia"),
    ("night changes", "one direction"),
]

print("=" * 100)
print("JIOSAAVN INTERNATIONAL CATALOG — ORIGINALS PRESENT? (top-10 results scanned)")
print("=" * 100)
for q, want_artist in TESTS:
    results = search(q, 12)
    found = None
    lines = []
    for r in results:
        mi = r.get("more_info") or {}
        pa = ((mi.get("artistMap") or {}).get("primary_artists") or [{}])
        artist = (pa[0].get("name", "?") if pa else "?").strip().lower()
        title = r.get("title", "?")
        dur = int(mi.get("duration", "0") or 0)
        lines.append(f"{title[:28]}|{artist[:20]}|{dur}s")
        wa = want_artist.lower()
        if (wa in artist or artist in wa) and abs(dur - 150) > 20:
            if not found: found = (r, title, artist, dur)
    marker = " ← ORIGINAL FOUND" if found else " (original NOT in top-12)"
    print(f"\n  q='{q}' want='{want_artist}'{marker}")
    print(f"    results: {' / '.join(lines[:6])}")
    if found:
        r, title, artist, dur = found
        enc = r["more_info"].get("encrypted_media_url", "")
        if enc:
            u = des_decrypt(enc).replace("_96.mp4", "_320.mp4")
            st2, hd2, body2 = http(u, timeout=25, max_bytes=12_000_000)
            if st2 == 200 and len(body2) > 400_000:
                f = tempfile.NamedTemporaryFile(delete=False, suffix=".m4a"); f.write(body2); f.close()
                d, br = fp(f.name); os.unlink(f.name)
                print(f"    ORIGINAL: {title} | {artist} | meta={dur}s real={d:.0f}s @{br}bps → {'FULL ✓' if d > 120 else 'short'}")
            else:
                print(f"    ORIGINAL stream: HTTP {st2} len={len(body2)} (geo-blocked?)")
