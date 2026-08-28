import { Innertube } from 'youtubei.js';
const vid = process.argv[2] || 'dQw4w9WgXcQ';
const yt = await Innertube.create({ retrieve_player: true });
const info = await yt.getInfo(vid);
const raw = info.page[0]; // first player response
const sd = raw.streamingData || {};
console.log('streamingData keys:', Object.keys(sd).join(', '));
console.log('videoPlaybackUstreamerConfig:', sd.videoPlaybackUstreamerConfig ? sd.videoPlaybackUstreamerConfig.slice(0, 80) + '...' : 'MISSING');
console.log('serverAbrStreamingUrl:', !!sd.serverAbrStreamingUrl);
// also check playerConfig
const pc = raw.playerConfig || {};
console.log('playerConfig keys:', Object.keys(pc).join(', '));
if (pc.streamingData) console.log('playerConfig.streamingData keys:', Object.keys(pc.streamingData).join(', '));
if (pc.streamingData?.serverAbrStreamingUrl) console.log('playerConfig has serverAbrStreamingUrl: true');
process.exit(0);
