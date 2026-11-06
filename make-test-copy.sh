#!/bin/sh
# Builds a separate TEST copy of Payday in ./test. It uses its own storage on the
# phone ("payday-test") and never writes to the GitHub backup.
set -e
rm -rf test && mkdir -p test
cp -R index.html app.css manifest.webmanifest sw.js icons js .nojekyll test/
sed -i.bak "s/const DB_NAME = 'payday';/const DB_NAME = 'payday-test';/" test/js/store.js
sed -i.bak "s/^export async function upload(cfg, key, salt, events, { knownSha = null, force = false, device = 'iphone' } = {}) {/&\n  throw new Error('Test copy: backups are switched off.');/" test/js/backup.js
printf '\nwindow.PAYDAY_TEST = true;\n' >> test/js/theme.js
sed -i.bak -e 's#<title>Payday</title>#<title>Payday Test</title>#' -e 's#content="Payday">#content="Payday Test">#' \
  -e 's#<main id="app"#<div class="testbar" role="note">TEST COPY</div>\n  <main id="app"#' test/index.html
sed -i.bak -e 's/"name": "Payday"/"name": "Payday Test"/' -e 's/"short_name": "Payday"/"short_name": "Pay Test"/' test/manifest.webmanifest
sed -i.bak "s/const VERSION = 'payday-/const VERSION = 'payday-test-/" test/sw.js
cat >> test/app.css <<'CSS'
.testbar { position: fixed; z-index: 50; top: env(safe-area-inset-top); left: 50%; transform: translateX(-50%); background: var(--orange); color: #000; font-size: 12px; font-weight: 800; padding: 2px 10px; border-radius: 0 0 10px 10px; pointer-events: none; white-space: nowrap; letter-spacing: .04em; }
CSS
find test -name '*.bak' -delete
