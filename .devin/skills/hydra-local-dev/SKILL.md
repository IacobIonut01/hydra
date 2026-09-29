---
name: hydra-local-dev
description: Set up and run the Hydra launcher (Electron + React + Rust native addons) from a fresh clone on macOS. Use when preparing the repo for `yarn dev`, when `yarn install` seems to hang inside vcpkg, when the window opens but catalogue/auth are silently dead (empty .env), when `hydra-native.node` fails with "mis-aligned LINKEDIT string pool", or when Electron launches and dies on `import 'electron'`.
---

# hydra-local-dev

Hydra is an Electron app built by electron-vite (`main`, `preload`, `renderer`,
plus an optional `big-picture` renderer). Torrenting is a Rust cdylib
(`native/hydra-native`) wrapping a C++ bridge over vcpkg-pinned libtorrent;
game streaming is a second Rust binary (`native/hydra-stream`, Windows-only).
`yarn install` runs `postinstall`, which builds the native addon, skips the
stream sidecar off Windows, runs `electron-builder install-app-deps`, and
downloads the ludusavi binary into `ludusavi/`.

## Setup

1. `npm i -g yarn@1.22.22` — `packageManager` pins yarn 1.x and `.npmrc` sets
   `engine-strict` (plain `npm install` fails by design). Node 25+ no longer
   ships corepack, so `corepack enable` is not an option on new Node.
2. Write `.env` at the repo root (gitignored). Production values:

   ```dotenv
   MAIN_VITE_API_URL=https://hydra-api-us-east-1.losbroxas.org
   MAIN_VITE_AUTH_URL=https://auth.hydralauncher.gg
   MAIN_VITE_CHECKOUT_URL=https://checkout.hydralauncher.gg
   MAIN_VITE_EXTERNAL_RESOURCES_URL=https://assets.hydralauncher.gg
   RENDERER_VITE_EXTERNAL_RESOURCES_URL=https://assets.hydralauncher.gg
   MAIN_VITE_WS_URL=wss://ws.hydralauncher.gg
   ```

   Leave `MAIN_VITE_LAUNCHER_SUBDOMAIN`, the two `RENDERER_VITE_*REFERRAL*`
   vars and `RENDERER_VITE_SENTRY_DSN` empty for local dev. The canonical
   production/staging table lives in the hydra-docs repo's
   `getting-started.md`; re-check it if an endpoint rotates.
3. On macOS 27 (Darwin 27) / Xcode 27, add this to `~/.cargo/config.toml`
   first or the native addon will build but never load — see traps:

   ```toml
   [profile.release]
   strip = "none"
   ```

4. `yarn install --frozen-lockfile`. First run compiles ~78 vcpkg ports
   (boost, openssl, libtorrent, libdatachannel) — 10+ minutes is normal.
5. `yarn dev` — electron-vite dev server plus Electron with HMR.
   `yarn dev:big-picture` serves `src/big-picture` standalone via plain vite.

## Traps

**Running `yarn dev` with a missing or empty `.env`.** The window opens fine
but `import.meta.env.MAIN_VITE_API_URL` is `undefined`, so every API call is
silently broken — blank catalogue, dead auth, no error pointing at the cause.
`.env.example` is also incomplete: the code additionally reads
`MAIN_VITE_CHECKOUT_URL`, `MAIN_VITE_EXTERNAL_RESOURCES_URL`,
`RENDERER_VITE_EXTERNAL_RESOURCES_URL` and `RENDERER_VITE_SENTRY_DSN`. Copy
the production block above, not the example.

**Setting `MAIN_VITE_LAUNCHER_SUBDOMAIN` for dev.** With it set,
`window-manager.ts` loads the renderer from a hosted release URL
(`https://release-v<version>.<subdomain>`) instead of local output — you run
someone else's build, not your code. Keep it empty.

**"mis-aligned LINKEDIT string pool" on `dlopen(hydra-native.node)`.** Not a
bad `ld`: cargo defaults `strip = "debuginfo"` on `--release`, and rustc's
llvm-objcopy strip pass rewrites `__LINKEDIT` leaving the `LC_SYMTAB` string
pool unaligned whenever the indirect-symbol count is odd — macOS 27 dyld
enforces 8-byte alignment (rust-lang/rust#157750). Fix once, user-wide:
`[profile.release] strip = "none"` in `~/.cargo/config.toml`. Apple's `strip`
reproduces the same misalignment, so post-processing is not a fix; neither is
`ld64.lld` (the strip pass runs after the link regardless). Cargo won't
relink a "fresh" cached artifact just because flags changed — `touch
native/hydra-native/src/lib.rs` to force one. `cargo clean -p hydra-native`
reports "Removed 0 files" here; use the touch, or delete
`native/hydra-native/target/release/libhydra_native.dylib` plus
`target/release/deps/libhydra_native*`.

**Electron starts then exits with `SyntaxError: 'electron' does not provide an
export named 'BrowserWindow'` / banner `Node.js vXX`.** `ELECTRON_RUN_AS_NODE=1`
is exported in your shell — Electron spawns as plain Node, and `import
'electron'` resolves to `node_modules/electron/index.js` (the binary-path
helper) instead of the in-app API. `unset ELECTRON_RUN_AS_NODE` and rerun.
Note `build-native-addon.cjs` sets this var on its verify child — it never
leaks from there; the leak is your own environment.

**`Electron failed to install correctly, please delete node_modules/electron`.**
The `electron` package's `install.js` never ran during install, so
`node_modules/electron/dist` is missing. Repair with
`node node_modules/electron/install.js`, then re-run `yarn build:native` —
vcpkg and cargo caches make it seconds, not minutes.

**Thinking `yarn install` is stuck.** The postinstall clones vcpkg at the
`builtin-baseline` pinned in `native/torrent-bridge/vcpkg.json` into
`~/.cache/hydra/v-<baseline8>` and source-builds every port; long quiet
stretches are normal. The vcpkg binary cache and cargo target dir make later
installs fast. Building the bridge also runs its ctest suite
(`torrent_bridge_ownership`) — a green build includes a green test.

**Tests: wrong runner expectation.** `yarn test` is Node's built-in runner
(`node --test` over `src/**/*.test.ts` via `scripts/register-ts-node.mjs`),
not jest/vitest. `yarn typecheck` is two passes: `typecheck:node` then
`typecheck:web`. `yarn test:stream` exercises the Rust stream sidecar and is
Windows-only.

**Worktrees missing `.env`.** `.env` is gitignored, so fresh worktrees start
without one. `.codex/environments/environment.toml` copies it from the main
checkout automatically; do the same by hand in a worktree set up outside
that flow.

## Verifying it

```bash
# Native addon string pool is aligned (stroff must be a multiple of 8):
otool -l hydra-native/hydra-native.node | grep stroff
# → e.g. 'stroff 9293560' (9293560 % 8 == 0 is good)

# Electron itself can load the addon (prefix form — does not persist):
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  -e "require('./hydra-native/hydra-native.node'); console.log('native ok')"
# → prints 'native ok', exit 0

# Ludusavi sidecar downloaded:
ls ludusavi/ludusavi

# End-to-end:
yarn dev   # → window opens, real catalogue streams in the main-process log
```
