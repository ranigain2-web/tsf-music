#!/bin/bash
# Package TSF Music into a clean, ready-to-run ZIP for local use.
# Contains ONLY what the app needs — no node_modules, no .next, no .git,
# no databases, no logs, no sandbox/debug artifacts.
set -euo pipefail

PROJECT_DIR="/home/z/my-project"
STAGE="$(mktemp -d)/tsf-music"
ZIP="/home/z/my-project/download/tsf-music.zip"

mkdir -p "${STAGE}"/{db,scripts}
cd "${PROJECT_DIR}"

# ---- app source ----
cp -r src prisma public "${STAGE}/"

# ---- config files ----
for f in package.json bun.lock tsconfig.json next.config.ts next-env.d.ts \
         tailwind.config.ts postcss.config.mjs eslint.config.mjs \
         components.json README.md MOBILE-SOLUTION.md MOBILE-PROGRESS.md \
         .env .env.example .gitignore; do
  cp "${f}" "${STAGE}/"
done

# ---- empty db dir marker (SQLite file is created on first `bun run dev`) ----
touch "${STAGE}/db/.gitkeep"

# ---- runtime scripts: zen benchmark data (read at runtime by src/lib/ai/zen.ts)
#      + the cache purge tool backing `npm run db:clear-cache` ----
cp scripts/zen-bench.ts scripts/zen-bench.json scripts/clear-cache.mjs "${STAGE}/scripts/" 2>/dev/null || true

# ---- local QA prompt (hand to the local model on the Mac for full testing) ----
cp /home/z/my-project/download/tsf-music-mobile-test-prompt.md "${STAGE}/QA-PROMPT.md" 2>/dev/null || true

# ---- QA evidence trail for the next agent ----
cp /home/z/my-project/QA-REPORT-2026-08-27.md "${STAGE}/QA-REPORT-2026-08-27.md" 2>/dev/null || true
mkdir -p "${STAGE}/docs"
cp -r /home/z/my-project/docs/. "${STAGE}/docs/" 2>/dev/null || true

# ---- sanity: no databases, no builds, no logs in the zip ----
find "${STAGE}" -name "*.db" -o -name "node_modules" -o -name ".next" -o -name "*.log" | grep . && { echo "DIRTY STAGE — aborting"; exit 1; } || true

# ---- zip it ----
rm -f "${ZIP}"
cd "$(dirname "${STAGE}")"
zip -qr "${ZIP}" tsf-music
cd "${PROJECT_DIR}"

echo "=== ZIP READY: ${ZIP} ==="
ls -lah "${ZIP}"
echo "---- contents (top level) ----"
unzip -l "${ZIP}" | awk '{print $4}' | grep -v '^$' | cut -d/ -f1-2 | sort -u | head -30
echo "---- file count ----"
unzip -l "${ZIP}" | tail -1
# v3 additions noted inline — see git-less worklog
