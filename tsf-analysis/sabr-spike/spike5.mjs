import { Innertube, Session } from 'youtubei.js';
import { BG, buildURL, USER_AGENT } from 'bgutils-js/botguard';
import { SabrStream } from 'googlevideo/sabr-stream';
import { writeFileSync } from 'node:fs';

const vid = process.argv[2] || 'dQw4w9WgXcQ';

console.log('[1] Innertube session...');
const yt = await Innertube.create({ retrieve_player: true });

const visitorData = yt.session.context.client.visitorData;
console.log('[2] visitorData:', visitorData ? visitorData.slice(0, 30) + '...' : 'MISSING');

console.log('[3] Requesting Botguard challenge...');
const requestKey = 'O43z0dpjhgX20SCx4KAo';
const bgConfig = {
  fetch: (input, init) => fetch(input, init),
  globalObj: globalThis,
  identifier: visitorData,
  requestKey,
};
const challengeResponse = await BG.Challenge.create(bgConfig);

if (!challengeResponse) throw new Error('Could not get challenge');
if (challengeResponse.challenge) {
  console.log('[4] Solving challenge (interpreting Botguard VM)...');
  const interpreterJS = challengeResponse.challenge;
  const poTokenResult = await BG.PoToken.generate({
    program: challengeResponse.challenge,
    globalName: challengeResponse.globalName,
    bgConfig,
  });
  const poToken = poTokenResult.poToken;
  console.log('[4b] PO TOKEN GENERATED:', poToken ? poToken.slice(0, 25) + '...' : 'FAILED');
  console.log('     integrity:', JSON.stringify(poTokenResult.integrityTokenBased ? 'token-based' : 'plain'));

  console.log('[5] getInfo with PO token context...');
  const info = await yt.getInfo(vid);
  const sd = info.streaming_data;
  const ustreamerConfig = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  const formats = (sd?.adaptive_formats || []).map(f => ({
    formatId: { itag: f.itag, lastModified: String(f.last_modified ?? '0'), xtags: f.xtags ?? '' },
    mimeType: f.mime_type,
    bitrate: f.bitrate,
    averageBitrate: f.average_bitrate,
    contentLength: String(f.content_length ?? '0'),
    audioQuality: f.audio_quality,
    quality: f.quality,
    approxDurationMs: String(f.approx_duration_ms ?? '0'),
  }));
  const audioPick = formats.filter(f => f.mimeType?.startsWith('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  console.log('[6] SabrStream WITH poToken...');
  const sabr = new SabrStream({
    serverAbrStreamingUrl: sd?.server_abr_streaming_url,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    poToken,
    durationMs: (info.basic_info?.duration || 200) * 1000,
    formats,
    clientInfo: { clientName: 3, clientVersion: yt.session.context.client.clientVersion, platform: 'DESKTOP', osName: 'Windows', osVersion: '10.0' },
  });
  sabr.on('streamProtectionStatusUpdate', (s) => console.log('  [protect]', JSON.stringify(s.status ?? s).slice(0, 120)));
  sabr.on('error', (e) => console.log('  [sabr-error]', String(e?.message || e).slice(0, 150)));

  const chunks = [];
  let audioBytes = 0;
  const t0 = Date.now();
  try {
    const { audioStream } = await sabr.start({ audioFormat: audioPick, videoFormat: undefined });
    const reader = audioStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      audioBytes += value.length;
      if (Date.now() - t0 > 30000) { reader.cancel(); break; }
    }
  } catch (e) {
    console.log('SABR PULL ERROR:', String(e?.message || e).slice(0, 300));
  }
  console.log(`[7] pulled ${audioBytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (audioBytes > 0) {
    writeFileSync('/home/z/my-project/tsf-analysis/sabr-spike/out-pot.webm', Buffer.concat(chunks));
    console.log('  saved out-pot.webm — first bytes:', Buffer.concat(chunks).slice(0, 8).toString('hex'));
  }
} else {
  console.log('challengeRequireIntegrity or no challenge:', JSON.stringify(challengeResponse).slice(0, 200));
}
process.exit(0);
