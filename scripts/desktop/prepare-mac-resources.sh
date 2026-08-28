#!/usr/bin/env bash
# TSF Music — prepare the macOS bundle resources for one target triple.
#
# Usage: prepare-mac-resources.sh <x86_64-apple-darwin|aarch64-apple-darwin>
#
# Fills src-tauri/resources/ with everything the Rust shell spawns:
#   runtime/bun          — bundled Bun runtime (per-arch official release)
#   bin/yt-dlp           — official macOS standalone build (x86_64; Rosetta on ASi)
#   bin/deno             — EJS challenge solver (per-arch, latest release)
#   server/              — Next standalone engine (built by `bun run build`)
#   pot-provider/        — bgutil POT token service + production node_modules
#   db/tsf.db            — fresh schema-only SQLite database
set -euo pipefail

TARGET_TRIPLE="${1:?usage: prepare-mac-resources.sh <target-triple>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RES="$ROOT/src-tauri/resources"
BUN_VERSION="${BUN_VERSION:-1.4.0}"

case "$TARGET_TRIPLE" in
  aarch64-apple-darwin)
    BUN_ARCH="aarch64"
    DENO_ASSET="deno-aarch64-apple-darwin.zip"
    ;;
  x86_64-apple-darwin)
    BUN_ARCH="x64"
    DENO_ASSET="deno-x86_64-apple-darwin.zip"
    ;;
  *)
    echo "unsupported target triple: $TARGET_TRIPLE" >&2
    exit 1
    ;;
esac

echo "▶ preparing resources for $TARGET_TRIPLE"
rm -rf "$RES"
mkdir -p "$RES/runtime" "$RES/bin" "$RES/db" "$RES/pot-provider" "$RES/server"

# 1) Bun runtime ------------------------------------------------------------
echo "▶ bun v$BUN_VERSION ($BUN_ARCH)"
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-${BUN_ARCH}.zip" -o /tmp/bun.zip
rm -rf /tmp/bun-extract && unzip -q /tmp/bun.zip -d /tmp/bun-extract
cp "/tmp/bun-extract/bun-darwin-${BUN_ARCH}/bun" "$RES/runtime/bun"
chmod +x "$RES/runtime/bun"

# 2) yt-dlp -----------------------------------------------------------------
# Official macOS standalone build. Historically an x86_64 Mach-O; on Apple
# Silicon it transparently runs under Rosetta 2 (auto-installed on demand).
echo "▶ yt-dlp (macos standalone)"
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" -o "$RES/bin/yt-dlp"
chmod +x "$RES/bin/yt-dlp"

# 3) deno (yt-dlp EJS challenge solver) --------------------------------------
# NOTE: use the releases/latest/download web redirect — the GitHub REST API
# (api.github.com/repos/.../releases/latest) 403s on shared runner IPs.
echo "▶ deno (latest release)"
curl -fsSL --retry 4 --retry-delay 5 \
  "https://github.com/denoland/deno/releases/latest/download/${DENO_ASSET}" \
  -o /tmp/deno.zip
rm -rf /tmp/deno-extract && unzip -q /tmp/deno.zip -d /tmp/deno-extract
cp /tmp/deno-extract/deno "$RES/bin/deno"
chmod +x "$RES/bin/deno"

# 4) Next standalone server ---------------------------------------------------
echo "▶ engine (standalone server)"
[ -d "$ROOT/.next/standalone" ] || { echo "missing .next/standalone — run `bun run build` first" >&2; exit 1; }
cp -R "$ROOT/.next/standalone" "$RES/server"

# Next's file tracing over-copies the project root (analysis dirs, archives,
# sandbox-only artifacts). Runtime needs only: server.js, package.json,
# node_modules, the dist dir (".next" or a custom TSF_DIST_DIR), public/.
(
  cd "$RES/server"
  find . -mindepth 1 -maxdepth 1 \
    ! -name 'server.js' \
    ! -name 'package.json' \
    ! -name 'node_modules' \
    ! -name '.next' \
    ! -name '.next-*' \
    ! -name 'public' \
    -exec rm -rf {} +
)

# Prisma file-tracing guard: the runtime must find BOTH darwin query engines
# (Intel + Apple Silicon) no matter which arch built the bundle.
PRISMA_CLI_DIR="$RES/server/node_modules/.prisma/client"
mkdir -p "$PRISMA_CLI_DIR"
cp -R "$ROOT/node_modules/.prisma/client/." "$PRISMA_CLI_DIR/" 2>/dev/null || true
for engine in libquery_engine-darwin.dylib.node libquery_engine-darwin-arm64.dylib.node; do
  [ -f "$PRISMA_CLI_DIR/$engine" ] || {
    echo "::error::missing prisma engine $engine in bundle" >&2
    exit 1
  }
done
echo "  prisma engines: darwin + darwin-arm64 ✓"

# 5) POT provider -------------------------------------------------------------
echo "▶ pot-provider (production node_modules, copyfile — no symlinks in bundles)"
(
  cd "$ROOT/mini-services/pot-provider"
  bun install --production --backend copyfile
)
cp "$ROOT/mini-services/pot-provider/index.js" "$RES/pot-provider/"
cp -R "$ROOT/mini-services/pot-provider/node_modules" "$RES/pot-provider/node_modules"

# 6) Fresh database -----------------------------------------------------------
echo "▶ database (schema-only sqlite)"
( cd "$ROOT" && DATABASE_URL="file:/tmp/tsf-fresh-$$.db" bunx prisma db push --skip-generate --accept-data-loss )
cp /tmp/tsf-fresh-*.db "$RES/db/tsf.db"

echo "✓ resources ready:"
du -sh "$RES"/* | sed 's/^/    /'
