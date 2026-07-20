# @collective/desktop

Electron shell for Collective (design spec §2.7.1). It hosts the shared web UI
(`apps/web`) unchanged and adds the things a browser cannot do: **system-audio
loopback** for the second channel of dual-channel capture (spec §2.1.1), a
global capture hotkey, tray presence, and single-instance behavior.

Plain CommonJS, zero build step — Electron loads `src/main.js` directly.

> **Why this package is not in the npm workspaces.** The repo-root
> `package.json` deliberately omits `apps/desktop` from `workspaces` so a root
> `npm install` (and therefore CI) never downloads the ~100 MB Electron
> binary. Install this package's deps separately, from this directory.

## Running it

1. **Install and start the web app and API** (from the repo root — these *are*
   workspaces):

   ```sh
   npm install
   npm run dev:server   # API on http://localhost:4000
   npm run dev:web      # web UI on http://localhost:5173
   ```

2. **Start the shell** (from `apps/desktop/`). Two ways:

   **Normal install** — downloads the Electron binary once, then runs offline:

   ```sh
   npm install
   npm start
   ```

   **One-off, no install** — run straight through npx. Note the explicitly
   *emptied* env var: if your shell/CI profile exports
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (as our check-only environments do),
   Electron installs without its binary and cannot launch, so clear it for
   the run:

   ```sh
   ELECTRON_SKIP_BINARY_DOWNLOAD= npx electron@31 .
   ```

   Conversely, to install dependencies *without* fetching the binary (lint /
   `node --check` environments, CI):

   ```sh
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
   ```

   The shell loads `COLLECTIVE_WEB_URL` if set, else `http://localhost:5173`.

## What works today, per platform

| Capability | Windows | macOS | Linux (dev only) |
|---|---|---|---|
| Shell window hosting web UI | yes | yes (hidden-inset title bar) | yes |
| Mic channel — `getUserMedia` in the renderer | yes | yes | yes |
| System channel — `getDisplayMedia` audio via loopback | **yes** — whole-device WASAPI loopback (shared mode) | **no** — handler grants video only and logs why; needs the native Core Audio taps module (backlog MC-2) | yes — PipeWire loopback |
| Global shortcut `Ctrl/Cmd+Shift+R` → focus + IPC `collective:start-capture` | yes | yes | yes |
| Tray (Start capture / Open Collective / Quit) | yes | yes (template icon, dark/light aware) | yes, where the DE shows tray icons |
| Single-instance lock (second launch focuses window) | yes | yes | yes |
| External links → default browser; all permissions denied except media/display-capture | yes | yes | yes |

The renderer discovers the capture strategy through the preload bridge:

```js
window.collective.platform;                    // "darwin" | "win32" | "linux"
await window.collective.getSystemAudioStreamHint();
// { supported: true,  how: "getDisplayMedia-loopback" }          win32/linux
// { supported: false, how: "unsupported-macos-taps-pending" }    darwin
window.collective.onStartCapture(() => { /* navigate to /capture */ });
```

## Intentionally not implemented here

These are native-module or later-phase work — tracked in
`docs/engineering-backlog-phase-0-1.md` and mapped in
`docs/desktop-capture.md`:

- **Per-process WASAPI loopback** (isolate the call app; build 20348+) — WC-2.
- **macOS system audio** (Core Audio process taps / ScreenCaptureKit fallback) — MC-2.
- **AEC** with the system channel as reference, headset detect/bypass — WC-3 / MC-3.
- **Encrypted local ring buffer** and crash-safe spooling — WC-4 / MC-4.
- **Call-detection nudge** — WC-5 / MC-5.
- Auto-update, code signing/notarization, installer packaging.
- Any UI: the shell renders `apps/web`; capture UX lives there.

Nothing in this package touches PHI by itself; audio handling happens in the
renderer (web app) and the native capture modules once they land.
