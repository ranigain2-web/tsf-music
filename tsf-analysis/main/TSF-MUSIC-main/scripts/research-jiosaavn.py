#!/usr/bin/env python3
"""
JioSaavn deep-dive: search → encrypted_media_url → DES-ECB decrypt (key '38346591')
→ full-length stream URL → download → ffprobe real duration.
Tests Bollywood AND English mainstream catalogs + CORS of the media CDN.
"""
import json, subprocess, urllib.request, urllib.parse, base64, re, os, tempfile

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ORIGIN = "https://preview-tsf.space-z.ai"

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

# --- DES-ECB decrypt via pycryptodome (key '38346591' as ASCII bytes) ---
from Crypto.Cipher import DES

def des_decrypt(b64_ciphertext: str) -> str:
    try:
        s = b64_ciphertext
        s += "=" * (-len(s) % 4)
        raw = base64.b64decode(s)
        cipher = DES.new(b"38346591", DES.MODE_ECB)
        out = cipher.decrypt(raw).decode("utf-8", "replace")
        return re.sub(r"[\x00-\x08\x0b-\x1f]+$", "", out).strip()
    except Exception as e:
        return f"DECRYPT-FAIL:{e}"

def fp(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration,format_name,bit_rate",
                              "-of", "json", path], capture_output=True, text=True, timeout=20)
        d = json.loads(out.stdout)["format"]
        return float(d["duration"]), d.get("format_name", "?"), d.get("bit_rate", "?")
    except Exception:
        return 0.0, "?", "?"

QUERIES = [
    "kesariya arijit singh",
    "shape of you ed sheeran",
    "bad guy billie eilish",
    "tum hi ho arijit singh",
    "blinding lights the weeknd",
    "apna bana le arijit singh",
    "ocean eyes billie eilish",
]

print("=" * 105)
print("JIOSAAVN FULL-LENGTH VERIFICATION")
print("=" * 105)
for q in QUERIES:
    qq = urllib.parse.quote(q)
    st, hd, body = http(
        f"https://www.jiosaavn.com/api.php?_format=json&__call=search.getResults&q={qq}&p=1&n=3&_marker=0&api_version=4&ctx=web6dot0",
        timeout=10)
    if st != 200:
        print(f"\n  {q}: HTTP {st} — unreachable"); continue
    txt = body.decode("utf-8", "replace").replace("/*\"}", "", 1)
    try:
        results = json.loads(txt).get("results") or []
    except Exception as e:
        print(f"\n  {q}: parse fail {e}"); continue
    if not results:
        print(f"\n  {q}: no results"); continue
    r0 = results[0]
    mi = r0.get("more_info") or {}
    title = r0.get("title", "?").replace("&quot;", '"')
    artist = (mi.get("artistMap") or {}).get("primary_artists", [{}])
    artist = artist[0].get("name", "?") if artist else "?"
    enc = mi.get("encrypted_media_url", "")
    dur_meta = int(mi.get("duration", "0") or 0)
    if not enc:
        print(f"\n  {q}: no encrypted_media_url"); continue
    url96 = des_decrypt(enc)
    if url96.startswith("DECRYPT-FAIL") or not url96.startswith("http"):
        print(f"\n  {q}: decrypt failed → {url96[:80]}"); continue
    url320 = url96.replace("_96.mp4", "_320.mp4")
    # try 320 first, fall back to 96
    for label, u in [("320kbps", url320), ("96kbps", url96)]:
        st2, hd2, body2 = http(u, headers={"Origin": ORIGIN, "Referer": "https://www.jiosaavn.com/"}, timeout=30, max_bytes=12_000_000)
        if st2 == 200 and len(body2) > 400_000:
            f = tempfile.NamedTemporaryFile(delete=False, suffix=".m4a"); f.write(body2); f.close()
            d, fmt, br = fp(f.name); os.unlink(f.name)
            full = "FULL-LENGTH ✓" if d > 120 else f"short ({d:.0f}s)"
            cors = hd2.get("Access-Control-Allow-Origin")
            # how much did we get? (max_bytes cap means duration is of PARTIAL file)
            print(f"\n  {q}")
            print(f"    → {title} | {artist} | meta={dur_meta}s")
            print(f"    → {label}: {len(body2)//1024}KB partial, dur={d:.0f}s fmt={fmt} bitrate={br} | {full} | media-CDN ACAO={cors}")
            break
    else:
        print(f"\n  {q}: media download failed (96:{url96[:40]}…)")

print("\n" + "=" * 105)
print("NOTES: 'partial dur' = duration of first 12MB slice; check meta vs slice: if partial dur ≈ meta → full file")
