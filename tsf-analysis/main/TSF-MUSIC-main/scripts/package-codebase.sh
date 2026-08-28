#!/bin/bash
# Package TSF Music codebase into a clean tarball for delivery.
# Excludes: node_modules, .next, .git, dev.log, db/, .zscripts/*.log, etc.

set -euo pipefail

PROJECT_DIR="/home/z/my-project"
UPLOAD_DIR="${PROJECT_DIR}/upload"
TARBALL="${UPLOAD_DIR}/tsf-music-$(date +%Y%m%d-%H%M%S).tar.gz"

mkdir -p "${UPLOAD_DIR}"

cd "${PROJECT_DIR}"

# Build a clean tarball excluding build artifacts, deps, logs, IDE files
tar --create --gzip \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./.git' \
  --exclude='./.zscripts' \
  --exclude='./dev.log' \
  --exclude='./tsconfig.tsbuildinfo' \
  --exclude='./db' \
  --exclude='./upload' \
  --exclude='./download' \
  --exclude './examples' \
  --exclude './mini-services' \
  --exclude './.vscode' \
  --exclude './.idea' \
  --file="${TARBALL}" \
  --transform 's,^\./,tsf-music/,' \
  ./src ./public ./prisma ./scripts ./skills ./package.json ./bun.lock ./tsconfig.json \
  ./next.config.ts ./next-env.d.ts ./tailwind.config.ts ./postcss.config.mjs \
  ./eslint.config.mjs ./components.json ./Caddyfile ./deno.lock \
  ./README.md ./worklog.md ./tests ./.env ./.gitignore 2>&1 | tail -5 || true

ls -lah "${TARBALL}"
echo "Tarball ready: ${TARBALL}"
echo "${TARBALL}" > "${UPLOAD_DIR}/latest.txt"
