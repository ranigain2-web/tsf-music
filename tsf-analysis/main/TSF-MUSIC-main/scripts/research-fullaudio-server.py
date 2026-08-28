#!/usr/bin/env python3
"""
TSF Music — DEEP RESEARCH: full-length audio source matrix.
Tests every candidate source for COMPLETE music (not 30s previews):
  1. InnerTube IOS / ANDROID_VR / WEB_REMIX  — playability + CORS (browser-callable?)
  2. Piped instances (x4)                    — CORS + stream resolution
  3. Invidious instances (x3)                — CORS + stream resolution
  4. JioSaavn unofficial API (saavn.dev)     — full-length Bollywood + mainstream
  5. JioSaavn original internal API          — full-length
  6. SoundCloud (scraped client_id)          — full-length
  7. Internet Archive                        — full-length (legal)
  8. Audius                                  — full-length (legal, indie)
Each result: reachable? full-length? CORS? download? duration (ffprobe).
"""
import json, subprocess, urllib.request, urllib.parse, re, os, tempfile

UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TEST_ORIGIN = "https://preview-tsf.space-z.ai"
VIDEO_ID = "JGwWNGJdvx8"  # Ed Sheeran - Shape of You (official)
RESULTS = []

def http(url, method="GET", headers=None, body=None, timeout=12):
    """Returns (status, headers-dict, body-bytes)."""
    h = {"User-Agent": UA_BROWSER, "Accept": "*/*"}
    if headers: h.update(headers)
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:2000]
    except Exception as e:
        return 0, {}, str(e).encode()[:300]

def ffprobe_duration(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration,format_name",
                              "-of", "json", path], capture_output=True, text=True, timeout=30)
        d = json.loads(out.stdout)
        return float(d["format"]["duration"]), d["format"].get("format_name", "?")
    except Exception:
        return 0.0, "?"

def report(name, **kv):
    RESULTS.append((name, kv))
    flags = " ".join(f"{k}={'✓' if v else '✗'}" for k, v in kv.items() if isinstance(v, bool))
    print(f"  {name:44} {flags}")

def save_tmp(data):
    f = tempfile.NamedTemporaryFile(delete=False, suffix=".bin")
    f.write(data); f.close()
    return f.name

print("=" * 100)
print("DEEP RESEARCH — FULL-LENGTH AUDIO SOURCE MATRIX  (server IP: datacenter)")
print("=" * 100)

# ============ 1. InnerTube clients: playability + CORS ============
print("\n[1] InnerTube /youtubei/v1/player — playability from server IP + CORS headers")
INNERTUBE_CLIENTS = [
    ("IOS", "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc", "https://www.youtube.com",
     "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
     {"clientName": "IOS", "clientVersion": "20.10.4", "deviceMake": "Apple", "deviceModel": "iPhone16,2",
      "osName": "iPhone", "osVersion": "18.3.2.22D82", "hl": "en"}),
    ("ANDROID_VR", "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w", "https://www.youtube.com",
     "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
     {"clientName": "ANDROID_VR", "clientVersion": "1.60.19", "deviceMake": "Meta", "deviceModel": "Quest 3",
      "osName": "Android", "osVersion": "12L", "androidSdkVersion": 32, "hl": "en"}),
    ("WEB_REMIX", "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30", "https://music.youtube.com",
     UA_BROWSER,
     {"clientName": "WEB_REMIX", "clientVersion": "1.20240403.01.00", "hl": "en", "gl": "US"}),
    ("WEB", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", "https://www.youtube.com",
     UA_BROWSER,
     {"clientName": "WEB", "clientVersion": "2.20241201.01.00", "hl": "en", "gl": "US"}),
]
for name, key, host, ua, ctx in INNERTUBE_CLIENTS:
    payload = json.dumps({"videoId": VIDEO_ID, "contentCheckOk": True, "racyCheckOk": True,
                          "context": {"client": ctx}})
    st, hd, body = http(f"{host}/youtubei/v1/player?key={key}&prettyPrint=false",
                        method="POST", headers={"Content-Type": "application/json",
                                                "User-Agent": ua, "Origin": TEST_ORIGIN}, body=payload)
    try: j = json.loads(body)
    except Exception: j = {}
    play = (j.get("playabilityStatus") or {}).get("status", "?")
    acao = hd.get("Access-Control-Allow-Origin") or hd.get("access-control-allow-origin")
    has_stream = bool((j.get("streamingData") or {}).get("adaptiveFormats") or (j.get("streamingData") or {}).get("formats"))
    report(f"innertube-{name}", reachable=st == 200, playable=play == "OK",
           cors=(acao is not None), stream_urls=has_stream,
           extra=f"status={st} playability={play} ACAO={acao}")

# ============ 2. Piped instances ============
print("\n[2] Piped instances — /streams/{id} from server + CORS")
for base in ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de",
             "https://api.piped.private.coffee", "https://pipedapi.drgns.space"]:
    st, hd, body = http(f"{base}/streams/{VIDEO_ID}", headers={"Origin": TEST_ORIGIN})
    acao = hd.get("Access-Control-Allow-Origin") or hd.get("access-control-allow-origin")
    has_audio = False
    try: has_audio = bool(json.loads(body).get("audioStreams"))
    except Exception: pass
    report(f"piped {base.split('//')[1]}", reachable=st == 200, streams=has_audio,
           cors=(acao is not None), extra=f"status={st} ACAO={acao}")

# ============ 3. Invidious instances ============
print("\n[3] Invidious instances — /api/v1/videos/{id} from server + CORS")
for base in ["https://inv.nadeko.net", "https://invidious.nerdvpn.de", "https://yewtu.be"]:
    st, hd, body = http(f"{base}/api/v1/videos/{VIDEO_ID}", headers={"Origin": TEST_ORIGIN})
    acao = hd.get("Access-Control-Allow-Origin") or hd.get("access-control-allow-origin")
    has_audio = False
    try: has_audio = bool(json.loads(body).get("adaptiveFormats"))
    except Exception: pass
    report(f"invidious {base.split('//')[1]}", reachable=st == 200, streams=has_audio,
           cors=(acao is not None), extra=f"status={st} ACAO={acao}")

# ============ 4. JioSaavn unofficial API (saavn.dev) ============
print("\n[4] JioSaavn unofficial API (saavn.dev) — FULL-LENGTH mainstream/Bollywood?")
st, hd, body = http("https://saavn.dev/api/search/songs?query=kesariya%20arijit%20singh&limit=2",
                    headers={"Origin": TEST_ORIGIN, "Accept": "application/json"})
acao = hd.get("Access-Control-Allow-Origin") or hd.get("access-control-allow-origin")
try:
    j = json.loads(body)
    songs = (j.get("data") or {}).get("results") or []
    if not songs: raise ValueError("no results")
    s0 = songs[0]
    dls = s0.get("downloadUrl") or []
    best = dls[-1] if dls else {}
    url = best.get("url", "")
    dur_meta = float(s0.get("duration") or 0)
    full = False; dur_real = 0.0; fmt = "?"
    if url:
        st2, hd2, body2 = http(url, headers={"Origin": TEST_ORIGIN})
        if st2 == 200 and len(body2) > 500000:
            p = save_tmp(body2); dur_real, fmt = ffprobe_duration(p); os.unlink(p)
            full = dur_real > 120
    report("saavn.dev kesariya", reachable=st == 200, full_length=full, cors=(acao is not None),
           download=(len(body2) > 500000 if url else False),
           extra=f"meta={dur_meta}s real={dur_real:.0f}s fmt={fmt} quality={best.get('quality')} size={len(body2)//1024}KB")
except Exception as e:
    report("saavn.dev kesariya", reachable=st == 200, full_length=False, cors=(acao is not None),
           extra=f"parse-fail: {e} body={body[:120]}")

# ============ 5. JioSaavn original internal API ============
print("\n[5] JioSaavn original internal API (jiosaavn.com/api.php)")
q = urllib.parse.quote("shape of you")
st, hd, body = http(f"https://www.jiosaavn.com/api.php?_format=json&__call=search.getResults&q={q}&p=1&n=2&_marker=0&api_version=4&ctx=web6dot0",
                    headers={"Origin": TEST_ORIGIN, "Accept": "*/*"})
acao = hd.get("Access-Control-Allow-Origin") or hd.get("access-control-allow-origin")
ok = False; extra = f"status={st} ACAO={acao} len={len(body)}"
try:
    txt = body.decode("utf-8", "replace")
    if txt.startswith("/*\"}"): txt = txt.replace("/*\"}", "", 1)  # jsonp guard
    j = json.loads(txt)
    res = j.get("results") or []
    ok = bool(res)
    extra += f" results={len(res)}"
except Exception as e:
    extra += f" parse-fail {e}"
report("jiosaavn.com search.getResults", reachable=st == 200, works=ok, cors=(acao is not None), extra=extra)

# ============ 6. SoundCloud (scrape client_id) ============
print("\n[6] SoundCloud — scrape client_id from web bundle, search, full-length stream")
st, hd, body = http("https://soundcloud.com/", headers={"Origin": TEST_ORIGIN})
client_id = None
if st == 200:
    js_paths = re.findall(r"<script[^>]+src=\"(https://a-v2\.sndcdn\.com/assets/[^\" ]+\.js)\"", body.decode("utf-8", "replace"))
    for jp in js_paths[::-1][:6]:  # newest bundles last
        st2, hd2, body2 = http(jp)
        m = re.search(r"client_id[\"']?\s*[:=]\s*[\"']([a-zA-Z0-9]{30,40})[\"']", body2.decode("utf-8", "replace"))
        if m: client_id = m.group(1); break
if client_id:
    st3, hd3, body3 = http(f"https://api-v2.soundcloud.com/search/tracks?q=shape%20of%20you%20ed%20sheeran&client_id={client_id}&limit=5",
                           headers={"Origin": TEST_ORIGIN})
    acao3 = hd3.get("Access-Control-Allow-Origin")
    try:
        tracks = json.loads(body3).get("collection") or []
        full_ok = False; dur = 0.0; fmt = "?"; dl_ok = False
        for t in tracks:
            if t.get("duration", 0) > 150000 and t.get("streamable") and t.get("full_duration", 0) > 150000:
                tc = [x for x in (t.get("media") or {}).get("transcodings") or [] if x.get("format", {}).get("protocol") == "progressive"]
                if tc:
                    su, hu, bu = http(tc[0]["url"] + f"?client_id={client_id}", headers={"Origin": TEST_ORIGIN})
                    if su == 200:
                        mu = json.loads(bu).get("url", "")
                        if mu:
                            sm, hm, bm = http(mu, headers={"Origin": TEST_ORIGIN})
                            if sm == 200 and len(bm) > 500000:
                                p = save_tmp(bm); dur, fmt = ffprobe_duration(p); os.unlink(p)
                                full_ok = dur > 120; dl_ok = True
                                break
        report("soundcloud (scraped id)", reachable=True, full_length=full_ok,
               cors=(acao3 is not None), download=dl_ok,
               extra=f"client_id={client_id[:8]}… track-dur={dur:.0f}s fmt={fmt}")
    except Exception as e:
        report("soundcloud (scraped id)", reachable=True, full_length=False, cors=(acao3 is not None), extra=f"parse-fail {e}")
else:
    report("soundcloud (scraped id)", reachable=False, full_length=False, cors=False, extra="client_id scrape failed")

# ============ 7. Internet Archive (legal full-length) ============
print("\n[7] Internet Archive — legal full-length live/public-domain music")
st, hd, body = http("https://archive.org/advancedsearch.php?q=subject%3A%22grateful+dead%22+AND+mediatype%3Aaudio&fl%5B%5D=identifier&rows=3&output=json",
                    headers={"Origin": TEST_ORIGIN})
acao = hd.get("Access-Control-Allow-Origin")
try:
    docs = json.loads(body).get("response", {}).get("docs") or []
    ident = docs[0]["identifier"] if docs else ""
    full = False; dur = 0.0; fmt = "?"; dl = False
    if ident:
        st2, hd2, body2 = http(f"https://archive.org/metadata/{ident}", headers={"Origin": TEST_ORIGIN})
        files = json.loads(body2).get("files") or []
        mp3s = [f for f in files if f.get("name", "").endswith(".mp3") and float(f.get("size", 0) or 0) > 3e6]
        if mp3s:
            st3, hd3, body3 = http(f"https://archive.org/download/{ident}/{urllib.parse.quote(mp3s[0]['name'])}",
                                   headers={"Origin": TEST_ORIGIN})
            if st3 == 200 and len(body3) > 500000:
                p = save_tmp(body3); dur, fmt = ffprobe_duration(p); os.unlink(p)
                full = dur > 300; dl = True
    report("archive.org (live music)", reachable=st == 200, full_length=full, cors=(acao is not None), download=dl,
           extra=f"identifier={ident[:30]} dur={dur:.0f}s fmt={fmt}")
except Exception as e:
    report("archive.org (live music)", reachable=st == 200, full_length=False, cors=(acao is not None), extra=f"fail {e}")

# ============ 8. Audius (legal full-length, indie) ============
print("\n[8] Audius — legal full-length independent catalog")
st, hd, body = http("https://discoveryprovider.audius.co/v1/tracks/search?query=lofi&app_name=TSFMusic&limit=5",
                    headers={"Origin": TEST_ORIGIN})
try:
    trs = json.loads(body).get("data") or []
    full = False; dur = 0.0; fmt = "?"; dl = False
    for t in trs:
        if t.get("duration") and t["duration"] > 150:
            st2, hd2, body2 = http(f"https://discoveryprovider.audius.co/v1/tracks/{t['id']}/stream?app_name=TSFMusic",
                                   headers={"Origin": TEST_ORIGIN})
            if st2 == 200 and len(body2) > 500000:
                p = save_tmp(body2); dur, fmt = ffprobe_duration(p); os.unlink(p)
                full = dur > 120; dl = True
                break
    report("audius", reachable=st == 200, full_length=full, cors=True, download=dl,
           extra=f"track-dur={dur:.0f}s fmt={fmt}")
except Exception as e:
    report("audius", reachable=st == 200, full_length=False, cors=False, extra=f"fail {e}")

print("\n" + "=" * 100)
print("SUMMARY (server-side reachability — browser-side results separate)")
for name, kv in RESULTS:
    print(f"  {name:44} {' '.join(f'{k}={v}' for k, v in kv.items() if k != 'extra')}")
