// Task 4-c research: Spotify UI design tokens + mobile anatomy searches
import ZAI from 'z-ai-web-dev-sdk';
import { writeFileSync } from 'fs';

const QUERIES = [
  { q: 'Spotify design system Encore colors #121212 #1ed760 background-base text-subdued', n: 8, tag: 'encore-tokens' },
  { q: 'Spotify brand color hex green #1ED760 #191414 official brand guidelines', n: 6, tag: 'brand-colors' },
  { q: 'Spotify Circular Std font typography weights sizes UI design', n: 8, tag: 'typography' },
  { q: 'Spotify color palette #b3b3b3 #282828 #181818 web player UI hex codes', n: 6, tag: 'ui-hex' },
  { q: 'Spotify mobile app bottom navigation tabs Home Search Your Library Premium 2024', n: 8, tag: 'bottom-nav' },
  { q: 'Spotify app home screen layout shelves "quick picks" "made for you" grid rows', n: 8, tag: 'home-shelves' },
  { q: 'Spotify now playing screen layout buttons order devices queue lyrics expand', n: 8, tag: 'now-playing' },
  { q: 'Spotify miniplayer minimized player behavior tap expand swipe down mobile', n: 6, tag: 'miniplayer' },
  { q: 'Spotify lyrics screen design synced karaoke highlight bold green', n: 6, tag: 'lyrics' },
  { q: 'Spotify queue screen mobile reorder remove design', n: 6, tag: 'queue' },
  { q: 'Spotify Your Library screen mobile filter chips playlists artists albums sort grid', n: 8, tag: 'library' },
  { q: 'Spotify search screen mobile browse all genres colored cards recent searches', n: 6, tag: 'search' },
  { q: 'Spotify context menu long press track options add to queue go to artist radio', n: 6, tag: 'context-menu' },
  { q: 'Spotify app Play Store screenshots description UI breakdown 2024 2025', n: 6, tag: 'playstore' },
  { q: 'spotify.design Encore design system components tokens engineering', n: 6, tag: 'spotify-design' },
];

async function main() {
  const zai = await ZAI.create();
  const all = {};
  for (const { q, n, tag } of QUERIES) {
    try {
      const results = await zai.functions.invoke('web_search', { query: q, num: n });
      all[tag] = { query: q, results: results.map(r => ({ url: r.url, name: r.name, snippet: r.snippet, host: r.host_name, date: r.date })) };
      console.log(`OK ${tag}: ${results.length} results`);
    } catch (e) {
      all[tag] = { query: q, error: e.message };
      console.log(`ERR ${tag}: ${e.message}`);
    }
  }
  writeFileSync('/tmp/research-c/search-results.json', JSON.stringify(all, null, 2));
  console.log('saved /tmp/research-c/search-results.json');
}
main().catch(e => { console.error(e); process.exit(1); });
