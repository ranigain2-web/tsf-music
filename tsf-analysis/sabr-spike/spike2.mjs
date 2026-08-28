import { Innertube } from 'youtubei.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { writeFileSync } from 'node:fs';

const vid = process.argv[2] || 'dQw4w9WgXcQ';

console.log('[1] Innertube session...');
const yt = await Innertube.create({ retrieve_player: true });

console.log('[2] getInfo', vid);
const info = await yt.getInfo(vid);
const sd = info.streaming_data;
console.log('  playability:', info.playability_status?.status, '| sabr url:', !!sd?.server_abr_streaming_url, '| ustreamerConfig:', !!sd?.video_playback_ustreamer_config);
console.log('  title:', info.basic_info?.title, '| dur:', info.basic_info?.duration);

// Build SabrFormat list from adaptive formats (audio only selection)
const formats = (sd?.adaptive_formats || []).map(f => ({
  formatId: { itag: f.itag, lastModified: String(f.last_modified ?? '0'), xtags: f.xtags ?? '' },
  mimeType: f.mime_type,
  bitrate: f.bitrate,
  averageBitrate: f.average_bitrate,
  contentLength: String(f.content_length ?? '0'),
  audioQuality: f.audio_quality,
  quality: f.quality,
  approxDurationMs: String(f.approx_duration_ms ?? '0'),
  sampleRate: f.audio_sample_rate,
  channels: f.loudness_db !== undefined ? 2 : 2,
  projectionType: undefined,
  stereoChannels: 2,
 loudnessDb: f.loudness_db,
}));

const audioPick = formats.filter(f => f.mimeType?.startsWith('audio')).sort((a, b) => (b.bitrate||0)-(a.bitrate||0))[0];
console.log('[3] selected audio itag:', audioPick?.formatId.itag, audioPick?.mimeType, audioPick?.bitrate, 'bps');

console.log('[4] Starting SabrStream (audio-only)...');
const ustreamerConfig = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
console.log('[3b] ustreamerConfig:', ustreamerConfig ? 'present len=' + ustreamerConfig.length : 'MISSING');

const sabr = new SabrStream({
  serverAbrStreamingUrl: sd?.server_abr_streaming_url,
  videoPlaybackUstreamerConfig: ustreamerConfig,
  durationMs: (info.basic_info?.duration || 200) * 1000,
  formats,
  clientInfo: {
    clientName: 3,      // WEB
    clientVersion: yt.session.context.client.clientVersion,
    platform: 'DESKTOP',
    osName: 'Windows',
    osVersion: '10.0',
  },
});

sabr.on('streamProtectionStatusUpdate', (s) => console.log('  [protect]', JSON.stringify(s.status ?? s)));
sabr.on('error', (e) => console.log('  [sabr-error]', String(e?.message || e).slice(0, 200)));

const chunks = [];
let audioBytes = 0;
const t0 = Date.now();
try {
  const { audioStream } = await sabr.start({
    audioFormat: audioPick,
    videoFormat: undefined,
  });
  const reader = audioStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    audioBytes += value.length;
    if (Date.now() - t0 > 30000) { console.log('  [timeout-stop]'); await sabr.dispose?.(); reader.cancel(); break; }
  }
} catch (e) {
  console.log('SABR PULL ERROR:', String(e?.message || e).slice(0, 400));
}

console.log(`[5] pulled ${audioBytes} bytes in ${((Date.now()-t0)/1000).toFixed(1)}s`);
if (audioBytes > 0) {
  writeFileSync('/home/z/my-project/tsf-analysis/sabr-spike/out.fmp4', Buffer.concat(chunks.map(c => Buffer.from(c))));
  const head = Buffer.from(chunks[0]).slice(0, 16).toString('hex');
  console.log('  saved out.fmp4, first bytes:', head);
}
process.exit(0);
