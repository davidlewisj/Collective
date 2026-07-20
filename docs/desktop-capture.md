# Desktop capture — engineering note

**Scope:** how the Electron shell in `apps/desktop/` implements (and
deliberately defers) the desktop capture design in spec §2.1.1, under the
platform strategy of §2.7.1. Companion to the backlog epics E1.1 (WC-1..5,
Windows) and E1.2 (MC-1..5, macOS) in `engineering-backlog-phase-0-1.md`.

## 1. What the shell is

Spec §2.7.1 calls for a shared TypeScript/React core hosted in an Electron
shell, with capture done by **native audio modules** because "capture is
unavoidably native regardless of shell choice." `apps/desktop` is that shell:
plain CommonJS, no build step, hosting `apps/web` at
`COLLECTIVE_WEB_URL` (default `http://localhost:5173`). It contributes the
shell-level obligations of §2.7.1 — global hotkey
(`CommandOrControl+Shift+R` → IPC `collective:start-capture`), tray presence,
single-instance behavior — plus one piece of genuine capture plumbing
described next. Auto-update, signing, and packaging are out of scope for this
slice.

## 2. Dual-channel capture plan (spec §2.1.1)

The spec requires two synchronized channels, stored as separate streams
(stereo-multiplexed with aligned timestamps):

| Channel | How the renderer gets it today |
|---|---|
| **Mic** (the user; authoritative identity) | `navigator.mediaDevices.getUserMedia({ audio: ... })` — ordinary Chromium mic capture; device selection and hot-swap follow are WC-1/MC-1 |
| **System** (all remote participants) | `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`, answered in the main process by `session.setDisplayMediaRequestHandler(...)` which returns `audio: "loopback"` |

The `"loopback"` answer is the load-bearing line of `src/main.js`: on
**Windows** it makes Chromium open a **WASAPI loopback** capture on the render
endpoint (shared mode, whole device — exactly the §2.1.1 baseline mechanism,
`AUDCLNT_STREAMFLAGS_LOOPBACK`), and hands the renderer a plain
`MediaStreamTrack`. On **Linux** the same token maps to PipeWire loopback (a
dev convenience — Linux is not a shipping capture target). On **macOS**
Chromium has no loopback path, so the handler grants video only and logs that
the native taps module is required (§4); `window.collective.
getSystemAudioStreamHint()` tells the web UI the same thing
(`{supported:false, how:"unsupported-macos-taps-pending"}`) so it can fall
back to mic-only capture honestly rather than fail.

**Downstream:** both tracks are processed in the renderer (WebAudio:
resample, then multiplex mic=L / system=R with a shared clock, per §2.1.1
"stereo-multiplexed with aligned timestamps"), chunked to
`POST /meetings/:id/chunks` and streamed for live captions per §2.2 / IN-2.
The video track that necessarily rides along with `getDisplayMedia` is
stopped immediately — we want the audio, not the screen.

## 3. Why Windows ultimately needs a native module (WC-2)

Whole-device loopback captures *everything* the machine plays — the Teams
call, but also a Spotify track or a notification chime from another app. The
spec's upgrade path is **per-process loopback**: `ActivateAudioInterfaceAsync`
with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, targeting the detected
call app's process tree (include-tree mode), available on build 20348+ —
effectively Windows 11. Chromium's `"loopback"` token exposes only the
whole-device form; there is no way to reach the process-loopback activation
API from JS. That is a **node-addon (N-API, C++/Rust)** loaded in the main
process, streaming PCM to the renderer/uploader — story **WC-2**, with the
automatic fallback matrix (per-process → whole-device) it specifies. WC-1
(WASAPI input client with device model, hot-swap follow, route-change gap
markers) lives in the same module: `getUserMedia` is fine for the demo but
does not give us device-route observability the spec asks for.

## 4. Why macOS needs a native module (MC-2)

macOS has no loopback concept in Core Audio's public JS-reachable surface at
all. The spec's primary mechanism is **Core Audio process taps** —
`CATapDescription` / `AudioHardwareCreateProcessTap`, macOS 14.2+ — which can
tap a specific process's audio (or the whole system) cleanly; the fallback
for 13.x is **ScreenCaptureKit** audio capture. Both are native APIs
(Objective-C/Swift), both require the app to declare
`NSAudioCaptureUsageDescription` in `Info.plist`, and process taps prompt the
user for **system audio recording** permission on first use. The plan is a
**Swift helper** (either an N-API addon linking Swift, or a small XPC-style
helper binary streaming PCM over a pipe) owned by story **MC-2**, including
the guided TCC walkthrough and macOS 15 re-authorization handling its
acceptance criteria call out. Until MC-2 lands, macOS desktop capture is
mic-only, and the shell says so explicitly (log + preload hint) instead of
pretending.

## 5. AEC plan (WC-3 / MC-3)

If the user is on speakers, remote voices bleed into the mic channel and break
the invariant *mic channel ≈ the user's voice only* (which name attribution
in §2.3 leans on). Per §2.1.1, the capture engine runs **acoustic echo
cancellation on the mic channel using the system channel as the reference
signal** — this is precisely why the two channels must share a clock. Interim:
browser-level `echoCancellation: true` on `getUserMedia` helps but references
only audio the *renderer* plays, not the call app's output, so it is not the
real fix. The real AEC (system-channel-referenced, e.g. WebRTC AEC3 or
SpeexDSP inside the native capture module), plus **headset detection with AEC
bypass**, is WC-3/MC-3 and sits behind the SP-3 quality-bar spike. Timestamp
alignment between the two channels is therefore a hard requirement on the
native modules' output format, not a nice-to-have.

## 6. Permission / TCC UX per platform

- **Windows:** mic permission for the mic channel (OS-level microphone
  privacy setting must allow desktop apps). WASAPI loopback has **no
  documented OS consent prompt** — §2.1.1 notes this asymmetry. Inside the
  shell, Chromium's permission requests are policy-gated:
  `setPermissionRequestHandler` allows only `media` and `display-capture`
  (the latter is what `getDisplayMedia` raises; without it the loopback
  handler is never reached) and denies everything else. Consent for
  *recording the meeting* is not an OS concern — it is enforced by the §2.6
  consent gate (`POST /meetings/:id/start` returns `409 consent_required`).
- **macOS:** two TCC surfaces. Mic → standard microphone prompt
  (`NSMicrophoneUsageDescription`). System audio → the process-taps prompt
  gated by `NSAudioCaptureUsageDescription` (macOS 14.2+); the
  ScreenCaptureKit fallback is gated by the Privacy & Security pane, renamed
  **"Screen & System Audio Recording"** in macOS 15, which also periodically
  re-confirms grants. MC-2 owns the first-run guided System Settings
  walkthrough; the capture screen must display permission state and never
  start silently (§2.1.1).
- **Linux (dev only):** PipeWire/xdg-desktop-portal may show a picker
  depending on the desktop; irrelevant to shipping targets.

## 7. Not testable in Linux CI — hardware validation checklist

**This repository's CI runs on Linux and intentionally never installs the
Electron binary** (`apps/desktop` is outside the npm workspaces;
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` for any check-only install). CI therefore
validates only syntax (`node --check`). **None of the capture behavior below
can be validated in CI; each item requires a real machine:**

On **real Windows hardware** (one build ≥ 20348 machine and one Windows 10 < 20348 machine):

1. `getDisplayMedia` via the loopback handler yields an audio track carrying
   actual render-endpoint audio during a Teams/Zoom/Meet call; no consent
   prompt appears for loopback (baseline for **WC-2**).
2. Mic + loopback tracks stay aligned over a ≥ 30 min call; device hot-swap
   (headset plug/unplug, Bluetooth) behavior and gap markers (**WC-1**).
3. Per-process loopback activation, call-app process-tree targeting, and the
   fallback matrix on the pre-20348 machine (**WC-2**).
4. AEC quality on speakers vs. headset, bypass-on-headset detection (**WC-3**).
5. Encrypted ring-buffer survival across process kill / network loss (**WC-4**)
   and the call-detection nudge against real call apps (**WC-5**).

On **real macOS hardware** (one 14.2+ machine, one 13.x for the SCK fallback,
ideally one macOS 15 for re-authorization):

1. `hiddenInset` title bar, tray template icon in light/dark menu bars, and
   the mic-only fallback path end-to-end (baseline for this shell).
2. Process-tap capture via the Swift module; `NSAudioCaptureUsageDescription`
   prompt copy; SCK fallback on 13.x; macOS 15 "Screen & System Audio
   Recording" re-confirmation flow (**MC-1**, **MC-2**).
3. AEC parity (**MC-3**), Keychain-wrapped buffer (**MC-4**), call-detection
   nudge (**MC-5**).

Cross-platform on both: global shortcut conflicts with the OS/call apps,
single-instance focus behavior, and that the permission handler does not
block any legitimate `getUserMedia`/`getDisplayMedia` flow.
