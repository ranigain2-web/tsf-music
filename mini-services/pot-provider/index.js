// TSF-MUSIC mini-service: bgutil-ytdlp-pot-provider (v1.3.2)
// Generates YouTube proof-of-origin (PO) tokens via BotGuard for yt-dlp.
// Port 4416 (fixed). Entry re-exports the upstream compiled server.
process.env.BGUTIL_NO_COLOR = '1'
await import('./build/main.js')
