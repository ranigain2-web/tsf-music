import { Innertube } from 'youtubei.js';
const vid = process.argv[2] || 'dQw4w9WgXcQ';
const yt = await Innertube.create({ retrieve_player: true });
const info = await yt.getInfo(vid);
console.log('info keys:', Object.keys(info).join(', '));
const pr = info.player_response || info.page || {};
console.log('pr keys:', Object.keys(pr).join(', '));
const sd = pr.streamingData;
if (sd) {
  console.log('streamingData keys:', Object.keys(sd).join(', '));
  if (sd.videoPlaybackUstreamerConfig) console.log('USTREAMER FOUND:', String(sd.videoPlaybackUstreamerConfig).slice(0, 60) + '...');
}
// scan for ustreamer anywhere
function scan(obj, path) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (/ustreamer/i.test(k)) console.log('FOUND:', path + '.' + k, '=', String(v).slice(0, 50));
    if (typeof v === 'object' && path.split('.').length < 3) scan(v, path + '.' + k);
  }
}
scan(pr, 'pr');
process.exit(0);
