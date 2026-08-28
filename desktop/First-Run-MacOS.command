#!/bin/bash
# TSF Music — First-run fix for Gatekeeper (unsigned build).
#
# macOS Sequoia/Tahoe removed "Right click → Open" for unsigned apps. After
# you drag TSF Music into /Applications, run this file ONCE (double-click it
# in the DMG, or run it from Terminal). It strips the quarantine flag Apple
# adds to downloaded apps — no settings changes, no SIP changes.

APP="/Applications/TSF Music.app"

if [ ! -d "$APP" ]; then
  echo "⚠  TSF Music.app was not found in /Applications."
  echo "   1. Drag 'TSF Music.app' from this window onto Applications."
  echo "   2. Eject the DMG, then run this file again (double-click)."
  open -R .
  exit 1
fi

echo "▸ removing quarantine from: $APP"
xattr -cr "$APP"

if [ $? -eq 0 ]; then
  echo "✅ Done. TSF Music can now open normally (Launchpad → TSF Music)."
  echo "   (First launch may take ~5 seconds to boot its local engine.)"
  open "$APP"
else
  echo "❌ xattr failed — try:  sudo xattr -cr \"$APP\""
  exit 1
fi
