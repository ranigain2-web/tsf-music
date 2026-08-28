/**
 * TSF Music — InnerTube client registry
 * Metadata flows through WEB_REMIX (YT Music web).
 * Stream resolution tries multiple clients via the provider chain.
 *
 * Client configs cross-checked against yt-dlp master (2026-08-18) via the
 * Musify project's vendored youtube_explode_dart fork:
 *   - ANDROID_VR is dead (YouTube 403s ALL its formats since 2026-08-17,
 *     yt-dlp#17456) — kept only as a legacy long-shot.
 *   - VISIONOS is yt-dlp's ONLY default tokenless client right now — no PO
 *     Token needed. Added as the new head of the stream chain.
 *   - IOS bumped to the current 21.26.4 build.
 *   - TVHTML5 (with contentCheckOk/racyCheckOk) helps on restricted videos.
 * NOTE: googlevideo URLs resolved by app-style clients can be tied to the
 * resolving client's User-Agent — the byte proxy (stream/download routes)
 * MUST send the matching UA or risk 403s. StreamResult carries it.
 */

export interface InnertubeClient {
  name: string
  key: string
  host: string
  userAgent: string
  context: Record<string, unknown>
}

export const CLIENTS: Record<string, InnertubeClient> = {
  WEB_REMIX: {
    name: 'WEB_REMIX',
    key: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    host: 'https://music.youtube.com',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    context: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20240403.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
  VISIONOS: {
    name: 'VISIONOS',
    // No API key needed — the public web key works and yt-dlp omits it entirely.
    key: 'AIzaSyAOghZGza2MQSZkY_zfZ370N-PUdXEo8AI',
    host: 'https://www.youtube.com',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    context: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
  },
  IOS: {
    name: 'IOS',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    host: 'https://www.youtube.com',
    userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      clientName: 'IOS',
      clientVersion: '21.26.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      userAgent:
        'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      platform: 'MOBILE',
      osName: 'IOS',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      timeZone: 'UTC',
      gl: 'US',
      utcOffsetMinutes: 0,
    },
  },
  TVHTML5: {
    name: 'TVHTML5',
    key: 'AIzaSyAOghZGza2MQSZkY_zfZ370N-PUdXEo8AI',
    host: 'https://www.youtube.com',
    userAgent:
      'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    context: {
      clientName: 'TVHTML5',
      clientVersion: '7.20260707.07.00',
      deviceMake: '',
      deviceModel: '',
      hl: 'en',
      timeZone: 'UTC',
      gl: 'US',
      utcOffsetMinutes: 0,
      originalUrl: 'https://www.youtube.com/tv',
      theme: 'CLASSIC',
      platform: 'DESKTOP',
      clientFormFactor: 'UNKNOWN_FORM_FACTOR',
      webpSupport: false,
      configInfo: {},
      tvAppInfo: { appQuality: 'TV_APP_QUALITY_FULL_ANIMATION' },
      acceptHeader:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  },
  ANDROID_VR: {
    name: 'ANDROID_VR',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    host: 'https://www.youtube.com',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Meta',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
      hl: 'en',
    },
  },
  IOS_MUSIC: {
    name: 'IOS_MUSIC',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    host: 'https://music.youtube.com',
    userAgent: 'com.google.ios.youtubemusic/7.13.1 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      clientName: 'IOS_MUSIC',
      clientVersion: '7.13.1',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
  },
  ANDROID_MUSIC: {
    name: 'ANDROID_MUSIC',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    host: 'https://music.youtube.com',
    userAgent: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14; GB) gzip',
    context: {
      clientName: 'ANDROID_MUSIC',
      clientVersion: '7.27.52',
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
      hl: 'en',
    },
  },
}

export const SEARCH_FILTERS = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
}
