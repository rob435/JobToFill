#!/bin/bash
# Claude Code cloud sessions: install what `npm run lint`, `npm run test:unit` and `npm run test:e2e` need.
# Idempotent: dependencies are reinstalled only when package-lock.json changed, so a cached container starts at once.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

stamp=node_modules/.package-lock.sha256
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  # npm ci, never npm install: the lock file stays exactly as committed.
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
fi

# The e2e tests drive Chromium through Playwright. Cloud containers ship it in $PLAYWRIGHT_BROWSERS_PATH; fetch it
# only when the revision this Playwright wants is missing.
revision=$(node -p "require('./node_modules/playwright-core/browsers.json').browsers.find((b) => b.name === 'chromium').revision")
if [ ! -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}/chromium-$revision" ]; then
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install chromium
fi
