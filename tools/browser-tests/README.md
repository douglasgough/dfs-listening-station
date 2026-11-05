# Browser tests (dev only)

Headless-Chrome driver scripts used to verify UI tasks in a real browser. They are plain `.mjs` files, not
`node:test` files (no `.test.` in the name), so `node --test` skips them. `puppeteer-core` is NOT a runtime
dependency of the app; install it in a scratch directory outside the repo:

```sh
mkdir -p /tmp/bt && cd /tmp/bt && npm init -y && npm i puppeteer-core
# run from the scratch dir so that `puppeteer-core` resolves from its node_modules:
DFS_URL=https://dfs-listening-station.test/app.html node /path/to/repo/tools/browser-tests/t18-channel-panel.mjs
# or without installing anything permanently:
npx -y -p puppeteer-core node /path/to/repo/tools/browser-tests/t18-channel-panel.mjs
```

Environment: `DFS_URL` (default the lerd site above), `CHROME_PATH` (default macOS Google Chrome), `SHOT_DIR`
(default `/tmp`; screenshots are saved as `ui-t18-*.png`). The script exits non-zero if any check fails.

Scripts: `t18-channel-panel.mjs` (channel panel), `t18b-timeline.mjs` (timeline editor), `t19-matrix.mjs` (modulation matrix).
Each prints PASS/FAIL per check and writes screenshots to `SHOT_DIR`.
