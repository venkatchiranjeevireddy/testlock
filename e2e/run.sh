#!/usr/bin/env bash
# One-command browser E2E: builds both apps against the local mock Supabase and drives them in headless Chromium.
# Needs: node, python3 + playwright (+ `playwright install chromium`) + Pillow, ffmpeg. Apps must be `npm install`ed first.
set -euo pipefail
cd "$(dirname "$0")"
ASSETS=${ASSETS:-/tmp/wedding-ar-e2e}
./make_assets.sh "$ASSETS"
export VITE_SUPABASE_URL=http://127.0.0.1:54400 VITE_SUPABASE_ANON_KEY=test-anon
(cd ../dev-app    && npx vite build --outDir "$ASSETS/dev-dist"    --emptyOutDir >/dev/null)
(cd ../viewer-app && npx vite build --outDir "$ASSETS/viewer-dist" --emptyOutDir >/dev/null)
python3 run_e2e.py "$ASSETS" "$ASSETS/dev-dist" "$ASSETS/viewer-dist"
