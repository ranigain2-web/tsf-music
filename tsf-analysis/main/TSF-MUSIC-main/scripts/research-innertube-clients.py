#!/usr/bin/env python3
"""
Exhaustive InnerTube client sweep + fresh relay instance lists.
Any client that returns playability OK from this datacenter IP = full YouTube
audio for the preview deployment.
"""
import json, urllib.request

UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
VID = "JGwWNGJdvx8"

CLIENTS = [
    ("ANDROID_MUSIC", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://music.youtube.com",
     "com.google.android.apps.youtube.music.35.24.54 (Linux; U; Android 14) gzip",
     {"clientName": "ANDROID_MUSIC", "clientVersion": "7.03.52", "androidSdkVersion": 34,
      "osName": "Android", "osVersion": "14", "hl": "en", "gl": "US"}),
    ("IOS_MUSIC", "AIzaSyBAETezhmbPafgGVtFFLossLnpZzKtIW6g", "https://music.youtube.com",
     "com.google.android.apps.youtube.music.35.24.54 (Linux; U; Android 14) gzip",
     {"clientName": "IOS_MUSIC", "clientVersion": "7.03.52", "hl": "en", "gl": "US"}),
    ("MWEB", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://www.youtube.com",
     "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
     {"clientName": "MWEB", "clientVersion": "2.20241202.07.00", "hl": "en", "gl": "US"}),
    ("TVHTML5_SIMPLY_EMBEDDED_PLAYER", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://www.youtube.com",
     "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
     {"clientName": "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "clientVersion": "2.0", "hl": "en", "gl": "US"}),
    ("WEB_EMBEDDED_PLAYER", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://www.youtube.com",
     UA_BROWSER,
     {"clientName": "WEB_EMBEDDED_PLAYER", "clientVersion": "1.20241201.01.00", "hl": "en", "gl": "US"}),
    ("ANDROID_TESTSUITE", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://www.youtube.com",
     "com.google.android.youtube.testing.19.09.37 (Linux; U; Android 11) gzip",
     {"clientName": "ANDROID_TESTSUITE", "clientVersion": "1.9", "androidSdkVersion": 30, "hl": "en", "gl": "US"}),
    ("ANDROID", "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w", "https://www.youtube.com",
     "com.google.android.youtube.20.10.38 (Linux; U; Android 14) gzip",
     {"clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 34, "hl": "en", "gl": "US"}),
]

def http(url, method="GET", headers=None, body=None, timeout=10):
    h = {"User-Agent": UA_BROWSER, "Accept": "*/*"}
    if headers: h.update(headers)
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:1500]
    except Exception as e:
        return 0, {}, str(e).encode()[:200]

print("=== InnerTube client sweep (datacenter IP) ===")
for name, key, host, ua, ctx in CLIENTS:
    payload = json.dumps({"videoId": VID, "contentCheckOk": True, "racyCheckOk": True, "context": {"client": ctx}})
    st, hd, body = http(f"{host}/youtubei/v1/player?key={key}&prettyPrint=false", method="POST",
                        headers={"Content-Type": "application/json", "User-Agent": ua}, body=payload)
    try: j = json.loads(body)
    except Exception: j = {}
    play = (j.get("playabilityStatus") or {}).get("status", "?")
    reason = (j.get("playabilityStatus") or {}).get("reason", "")[:40]
    sd = j.get("streamingData") or {}
    fmts = len(sd.get("adaptiveFormats") or []) + len(sd.get("formats") or [])
    audio_url = ""
    for f in (sd.get("adaptiveFormats") or []):
        if f.get("mimeType", "").startswith("audio/") and f.get("url"):
            audio_url = f["url"][:60]; break
    print(f"  {name:34} status={st} playability={play:18} audioFmts={audio_url != ''} {reason} {audio_url}")

print("\n=== Piped registry (fresh) ===")
st, hd, body = http("https://piped-instances.kavin.rocks/", timeout=8)
print(f"  registry status={st}")
if st == 200:
    try:
        for it in json.loads(body)[:10]:
            print(f"    {it.get('api_url')} users={it.get('users_online')}?cdn={it.get('image_proxy_url','')[:30]}")
    except Exception as e: print(f"    parse fail {e} {body[:100]}")

print("\n=== Extra community Piped instances ===")
for base in ["https://pipedapi.reallyaweso.me", "https://api.piped.private.coffee", "https://pipedapi.ducks.party",
             "https://pipedapi.adminforge.de", "https://piapi.ggtyler.dev", "https://pipedapi.leptons.xyz"]:
    st, hd, body = http(f"{base}/streams/{VID}", timeout=8)
    ok = False
    try: ok = bool(json.loads(body).get("audioStreams"))
    except Exception: pass
    print(f"    {base:42} status={st} audio={ok}")

print("\n=== Extra community Invidious instances ===")
for base in ["https://invidious.f5.si", "https://iv.melmac.space", "https://invidious.privacyredirect.com",
             "https://inv.tux.pizza", "https://invidious.jing.rocks", "https://iv.datura.network",
             "https://invidious.dhusch.de", "https://inv.perditum.dev"]:
    st, hd, body = http(f"{base}/api/v1/videos/{VID}", timeout=8)
    ok = False
    try: ok = bool(json.loads(body).get("adaptiveFormats"))
    except Exception: pass
    print(f"    {base:42} status={st} audio={ok}")
