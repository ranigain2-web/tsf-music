import { Innertube } from 'youtubei.js';

const vid = process.argv[2] || 'dQw4w9WgXcQ';

console.log('[1] Creating Innertube session (server context)...');
const yt = await Innertube.create({ retrieve_player: true });

console.log('[2] getInfo for', vid);
try {
  const info = await yt.getInfo(vid);
  console.log('playability:', info.playability_status?.status, '|', info.playability_status?.reason || '');
  console.log('title:', info.basic_info?.title);
  console.log('duration:', info.basic_info?.duration);
  const fmts = info.streaming_data?.adaptive_formats || [];
  console.log('adaptive_formats count:', fmts.length);
  const withUrl = fmts.filter(f => f.url);
  console.log('formats WITH direct url:', withUrl.length);
  const audio = fmts.filter(f => f.mime_type?.startsWith('audio'));
  console.log('audio formats:', audio.length, '| with url:', audio.filter(f => f.url).length);
  const sabr = info.streaming_data?.server_abr_streaming_url;
  console.log('serverAbrStreamingUrl present:', !!sabr);
  if (sabr) console.log('sabr url host:', new URL(sabr).host);
  if (audio[0]) console.log('sample audio fmt:', audio[0].mime_type, audio[0].bitrate, audio[0].itag);
} catch (e) {
  console.log('getInfo ERROR:', e.message?.slice(0, 300));
}

console.log('[3] Trying specific clients...');
for (const client of ['IOS', 'TVHTML5', 'WEB']) {
  try {
    const info = await yt.getInfo(vid, client);
    const fmts = info.streaming_data?.adaptive_formats || [];
    const audioWithUrl = fmts.filter(f => f.mime_type?.startsWith('audio') && f.url);
    console.log(`${client}: status=${info.playability_status?.status} audioFmtsWithUrl=${audioWithUrl.length} sabr=${!!info.streaming_data?.server_abr_streaming_url}`);
    if (audioWithUrl[0]) {
      const u = audioWithUrl[0].url;
      const probe = await fetch(u, { headers: { 'Range': 'bytes=0-1', 'User-Agent': client === 'IOS' ? 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 21_26_4 like Mac OS X;)' : 'Mozilla/5.0' } });
      console.log(`   probe: HTTP ${probe.status} len=${probe.headers.get('content-range') || probe.headers.get('content-length')}`);
      if (probe.ok) { await probe.body?.cancel(); break; }
    }
  } catch (e) {
    console.log(`${client}: ERROR ${String(e.message).slice(0, 120)}`);
  }
}
console.log('[done]');
process.exit(0);
