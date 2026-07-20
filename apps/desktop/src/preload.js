// Collective desktop shell — preload script.
//
// Runs in the renderer with contextIsolation on, nodeIntegration off, and
// sandbox true (see webPreferences in src/main.js). The only bridge between
// the web UI and the shell is the small, explicit `window.collective` API
// exposed here — no Node primitives ever reach page code.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const START_CAPTURE_CHANNEL = "collective:start-capture";

// process.platform is available to sandboxed preloads; capture it once so the
// exposed object holds a plain string, not a live process reference.
const platform = process.platform;

contextBridge.exposeInMainWorld("collective", {
  /**
   * "darwin" | "win32" | "linux" — lets the web UI adapt copy and capture
   * strategy per platform (spec §2.1.1, §2.7.1).
   */
  platform,

  /**
   * Subscribe to the shell's "start capture" intent (global shortcut
   * CommandOrControl+Shift+R or the tray's "Start capture" item). The web UI
   * should navigate to /capture and begin the consent-gated flow.
   * Returns an unsubscribe function.
   */
  onStartCapture(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const listener = () => {
      callback();
    };
    ipcRenderer.on(START_CAPTURE_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(START_CAPTURE_CHANNEL, listener);
    };
  },

  /**
   * How (and whether) this platform can deliver the system-audio channel of
   * dual-channel capture (spec §2.1.1) to the renderer today.
   *
   *   { supported: true,  how: "getDisplayMedia-loopback" }
   *     Windows (WASAPI loopback) and Linux (PipeWire): call
   *     navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
   *     and use the audio track as the system channel. The main process's
   *     setDisplayMediaRequestHandler answers with audio: "loopback".
   *
   *   { supported: false, how: "unsupported-macos-taps-pending" }
   *     macOS: system audio requires the native Core Audio process-taps
   *     module (backlog MC-2; docs/desktop-capture.md). Capture mic-only.
   *
   * Async so the shape can later consult the main process (e.g. Windows
   * build number for per-process loopback) without changing callers.
   */
  async getSystemAudioStreamHint() {
    if (platform === "darwin") {
      return { supported: false, how: "unsupported-macos-taps-pending" };
    }
    return { supported: true, how: "getDisplayMedia-loopback" };
  },
});
