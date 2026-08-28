#!/usr/bin/env python3
"""Sections 2-8 with hard timeouts + fresh instance lists."""
import json, subprocess, urllib.request, urllib.parse, re, os, tempfile, socket

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ORIGIN = "https://preview-tsf.space-z.ai"
VID = "JGwWNGJdvx8"

def http(url, method="GET", headers=None, timeout=8, max_bytes=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, data=None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if max_bytes:
                data = r.read(max_bytes)
            else:
                data = r.read()
            return r.status, dict(r.headers), data
    except urllib.error.HTTPError as e:
        try: body = e.read()[:800]
        except Exception: body = b""
        return e.code, dict(e.headers), body
    except Exception as e:
        return 0, {}, str(e).encode()[:200]

def fp(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration,format_name",
                              "-of", "json", path], capture_output=True, text=True, timeout=20)
        d = json.loads(out.stdout)["format"]
        return float(d["duration"]), d.get("format_name", "?")
    except Exception:
        return 0.0, "?"

print("[A] Piped — fresh instance list")
st, hd, body = http("https://piped-instances.kavin.rocks/", timeout=8)
piped_list = []
if st == 200:
    try:
        for it in json.loads(body): piped_list.append("https://" + it["api_url"].replace("https://", ""))
    except Exception: pass
piped_list = (piped_list or ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de"])[:8]
print(f"    instances to test: {piped_list}")
alive_piped = []
for base in piped_list:
    st, hd, body = http(f"{base}/streams/{VID}", headers={"Origin": ORIGIN}, timeout=8)
    acao = hd.get("Access-Control-Allow-Origin")
    ok = False
    try: ok = bool(json.loads(body).get("audioStreams"))
    except Exception: pass
    if st == 200 and ok: alive_piped.append(base)
    print(f"    {base:45} status={st} audio={ok} ACAO={acao}")

print("\n[B] Invidious — fresh instance list")
st, hd, body = http("https://api.invidious.io/instances.json?sort_by=type,users", timeout=8)
inv_list = []
if st == 200:
    try:
        for name, it in json.loads(body):
            if it.get("type") == "https" and it.get("api"): inv_list.append("https://" + name)
    except Exception: pass
inv_list = (inv_list or ["https://inv.nadeko.net", "https://invidious.nerdvpn.de"])[:8]
print(f"    instances to test: {inv_list}")
alive_inv = []
for base in inv_list:
    st, hd, body = http(f"{base}/api/v1/videos/{VID}", headers={"Origin": ORIGIN}, timeout=8)
    acao = hd.get("Access-Control-Allow-Origin")
    ok = False
    try: ok = bool(json.loads(body).get("adaptiveFormats"))
    except Exception: pass
    if st == 200 and ok: alive_inv.append(base)
    print(f"    {base:45} status={st} audio={ok} ACAO={acao}")

print("\n[C] JioSaavn unofficial (saavn.dev)")
st, hd, body = http("https://saavn.dev/api/search/songs?query=kesariya%20arijit%20singh&limit=2",
                    headers={"Origin": ORIGIN, "Accept": "application/json"}, timeout=10)
acao = hd.get("Access-Control-Allow-Origin")
print(f"    status={st} ACAO={acao} len={len(body)}")
if st == 200:
    try:
        songs = (json.loads(body).get("data") or {}).get("results") or []
        s0 = songs[0]
        dls = s0.get("downloadUrl") or []
        print(f"    song: {s0.get('name')} | {s0.get('primaryArtists')} | meta-dur={s0.get('duration')}s | qualities={[d.get('quality') for d in dls]}")
        best = dls[-1]
        st2, hd2, body2 = http(best.get("url", ""), headers={"Origin": ORIGIN}, timeout=25, max_bytes=4_000_000)
        if st2 == 200 and len(body2) > 300_000:
            f = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4"); f.write(body2); f.close()
            d, fmt = fp(f.name); os.unlink(f.name)
            print(f"    DOWNLOAD: {len(body2)//1024}KB real-dur={d:.0f}s fmt={fmt} → FULL-LENGTH={'YES' if d > 120 else 'no'}")
        else:
            print(f"    download failed: status={st2} len={len(body2)}")
    except Exception as e:
        print(f"    parse fail: {e} body={body[:150]}")

print("\n[D] JioSaavn original (jiosaavn.com/api.php)")
q = urllib.parse.quote("kesariya")
st, hd, body = http(f"https://www.jiosaavn.com/api.php?_format=json&__call=search.getResults&q={q}&p=1&n=2&_marker=0&api_version=4&ctx=web6dot0",
                    headers={"Origin": ORIGIN}, timeout=10)
acao = hd.get("Access-Control-Allow-Origin")
txt = body.decode("utf-8", "replace").replace("/*\"}", "", 1)
try:
    res = json.loads(txt).get("results") or []
    print(f"    status={st} ACAO={acao} results={len(res)}")
    if res:
        print(f"    first: {res[0].get('title')} | {res[0].get('more_info',{}).get('artistMap',{}).get('primary_artists',[{}])[0].get('name','?')}")
except Exception as e:
    print(f"    parse fail: {e} body={txt[:120]}")

print("\n[E] SoundCloud — scrape client_id (optimized)")
client_id = None
st, hd, body = http("https://soundcloud.com/", timeout=10)
if st == 200:
    js_paths = re.findall(r'src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', body.decode("utf-8", "replace"))
    print(f"    homepage: {len(js_paths)} js bundles")
    for jp in js_paths[::-1][:3]:
        st2, hd2, body2 = http(jp, timeout=10, max_bytes=3_000_000)
        m = re.search(r'client_id["\']?\s*[:=]\s*["\']([a-zA-Z0-9]{30,40})["\']', body2.decode("utf-8", "replace"))
        if m: client_id = m.group(1); break
if client_id:
    print(f"    client_id: {client_id[:10]}…")
    st3, hd3, body3 = http(f"https://api-v2.soundcloud.com/search/tracks?q=shape%20of%20you&client_id={client_id}&limit=8",
                           headers={"Origin": ORIGIN}, timeout=10)
    acao3 = hd3.get("Access-Control-Allow-Origin")
    print(f"    search: status={st3} ACAO={acao3}")
    try:
        for t in json.loads(body3).get("collection") or []:
            if t.get("full_duration", 0) > 150000 and t.get("streamable"):
                tc = [x for x in (t.get("media") or {}).get("transcodings") or [] if x.get("format", {}).get("protocol") == "progressive"]
                if tc:
                    su, hu, bu = http(tc[0]["url"] + f"?client_id={client_id}", headers={"Origin": ORIGIN}, timeout=10)
                    if su == 200:
                        mu = json.loads(bu).get("url", "")
                        if mu:
                            sm, hm, bm = http(mu, headers={"Origin": ORIGIN}, timeout=20, max_bytes=4_000_000)
                            if sm == 200 and len(bm) > 300_000:
                                f = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3"); f.write(bm); f.close()
                                d, fmt = fp(f.name); os.unlink(f.name)
                                print(f"    FULL TRACK: {t['title'][:40]} dur={d:.0f}s fmt={fmt} {len(bm)//1024}KB ACAO={hm.get('Access-Control-Allow-Origin')}")
                                break
    except Exception as e:
        print(f"    fail: {e}")
else:
    print("    client_id scrape FAILED")

print("\n[F] Internet Archive (legal full-length)")
st, hd, body = http("https://archive.org/advancedsearch.php?q=subject%3A%22grateful+dead%22+AND+mediatype%3Aaudio&fl%5B%5D=identifier&rows=3&output=json",
                    headers={"Origin": ORIGIN}, timeout=10)
acao = hd.get("Access-Control-Allow-Origin")
try:
    docs = json.loads(body).get("response", {}).get("docs") or []
    ident = docs[0]["identifier"]
    st2, hd2, body2 = http(f"https://archive.org/metadata/{ident}", headers={"Origin": ORIGIN}, timeout=10)
    files = json.loads(body2).get("files") or []
    mp3s = sorted([f for f in files if f.get("name", "").endswith(".mp3") and float(f.get("size", 0) or 0) > 3e6], key=lambda x: float(x["size"]))
    if mp3s:
        smf = mp3s[0]
        st3, hd3, body3 = http(f"https://archive.org/download/{ident}/{urllib.parse.quote(smf['name'])}",
                               headers={"Origin": ORIGIN}, timeout=25, max_bytes=4_000_000)
        if st3 == 200:
            f = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3"); f.write(body3); f.close()
            d, fmt = fp(f.name); os.unlink(f.name)
            print(f"    {ident[:28]} file={smf['name'][:30]} partial-dur={d:.0f}s (of {float(smf.get('size',0))/16000/1000*1000:.0f}s est) ACAO={acao}")
    print(f"    ACAO={acao} (CORS {'OK' if acao else 'NO'})")
except Exception as e:
    print(f"    fail: {e}")

print("\n[G] Audius (legal full-length indie)")
st, hd, body = http("https://discoveryprovider.audius.co/v1/tracks/search?query=lofi&app_name=TSFMusic&limit=5",
                    headers={"Origin": ORIGIN}, timeout=10)
try:
    for t in json.loads(body).get("data") or []:
        if t.get("duration") and t["duration"] > 150:
            st2, hd2, body2 = http(f"https://discoveryprovider.audius.co/v1/tracks/{t['id']}/stream?app_name=TSFMusic",
                                   headers={"Origin": ORIGIN}, timeout=20, max_bytes=4_000_000)
            if st2 == 200 and len(body2) > 300_000:
                f = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3"); f.write(body2); f.close()
                d, fmt = fp(f.name); os.unlink(f.name)
                print(f"    FULL: {t['title'][:40]} dur={d:.0f}s fmt={fmt} {len(body2)//1024}KB ACAO={hd2.get('Access-Control-Allow-Origin')}")
                break
except Exception as e:
    print(f"    fail: {e}")

print("\n[DONE]")
