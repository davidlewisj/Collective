// Collective desktop shell — Electron main process.
//
// Plain CommonJS, zero build step. Hosts the shared web UI (apps/web) and
// provides the OS-level plumbing the browser cannot: system-audio loopback for
// the "system channel" of dual-channel capture (design spec §2.1.1), a global
// capture hotkey, tray presence, and single-instance behavior (§2.7.1).
//
// What this shell deliberately does NOT do: native per-process WASAPI loopback,
// macOS Core Audio process taps, AEC, or encrypted local buffering. Those are
// native-module work tracked as backlog stories WC-1..5 / MC-1..5 — see
// docs/desktop-capture.md for the full mapping.

"use strict";

const path = require("node:path");
const zlib = require("node:zlib");

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  globalShortcut,
  nativeImage,
  session,
  shell,
} = require("electron");

const WEB_URL = process.env.COLLECTIVE_WEB_URL || "http://localhost:5173";
const START_CAPTURE_CHANNEL = "collective:start-capture";
const CAPTURE_SHORTCUT = "CommandOrControl+Shift+R";

// Packaged builds bundle the web app (apps/web/dist copied to ./web by the
// release workflow) and serve it from a loopback-only static server, injecting
// window.__COLLECTIVE_API__ so the UI talks to the configured Collective
// server. Configure via COLLECTIVE_API_URL or userData/config.json
// ({"apiUrl": "https://collective.example.org"}); default is a local dev
// server. Dev runs (no ./web folder) keep loading the Vite dev server URL.
const http = require("node:http");
const fs = require("node:fs");

/** Resolved at startup; loadURL target for the main window. */
let webUrl = WEB_URL;

function resolveApiUrl() {
  if (process.env.COLLECTIVE_API_URL) return process.env.COLLECTIVE_API_URL;
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (typeof cfg.apiUrl === "string" && cfg.apiUrl) return cfg.apiUrl;
  } catch {
    /* no config file — fall through to default */
  }
  return "http://localhost:4000";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function startBundledWebServer() {
  const webDir = path.join(__dirname, "..", "web");
  if (!fs.existsSync(path.join(webDir, "index.html"))) return Promise.resolve(null);
  const apiUrl = resolveApiUrl();
  const inject = `<script>window.__COLLECTIVE_API__=${JSON.stringify(apiUrl)};</script>`;
  const index = fs
    .readFileSync(path.join(webDir, "index.html"), "utf8")
    .replace("<head>", `<head>${inject}`);

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = path.normalize(path.join(webDir, reqPath));
    // SPA fallback + path-traversal guard: anything outside webDir or missing
    // serves the (injected) index.
    if (filePath.startsWith(webDir) && reqPath !== "/" && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(index);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      console.log(`[collective] bundled web UI on http://127.0.0.1:${address.port} → API ${apiUrl}`);
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Single-instance lock: a second launch focuses the existing window instead.
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(onReady).catch((err) => {
    console.error("[collective] failed to initialize:", err);
    app.quit();
  });
}

async function onReady() {
  installDisplayMediaRequestHandler(session.defaultSession);
  installPermissionRequestHandler(session.defaultSession);
  webUrl = (await startBundledWebServer()) || WEB_URL;
  createMainWindow();
  createTray();
  registerGlobalShortcut();
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createMainWindow() {
  const options = {
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#FAF8F4", // spec §7.2.1 core palette background
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  if (process.platform === "darwin") {
    options.titleBarStyle = "hiddenInset";
  }

  mainWindow = new BrowserWindow(options);

  mainWindow.loadURL(webUrl).catch((err) => {
    console.error(
      `[collective] could not load ${webUrl} — is the web dev server running?`,
      err
    );
  });

  // External links open in the OS default browser, never inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    // Closing the window keeps Collective alive in the tray (capture apps are
    // expected to be resident); "Quit" in the tray menu actually exits.
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function requestStartCapture() {
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    // The renderer (preload → window.collective.onStartCapture) navigates to
    // /capture and begins the §2.6-gated capture flow.
    mainWindow.webContents.send(START_CAPTURE_CHANNEL);
  }
}

// ---------------------------------------------------------------------------
// System-audio capture plumbing (the important part).
//
// The renderer asks for system audio with navigator.mediaDevices.getDisplayMedia.
// Chromium routes that request here. Answering with `audio: "loopback"` makes
// Electron capture the OS render endpoint:
//   - Windows: WASAPI loopback (shared mode) — spec §2.1.1 "System channel".
//     This is whole-device loopback; the per-process upgrade
//     (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, build 20348+) is native-
//     module work tracked as WC-2.
//   - Linux: PipeWire loopback (dev convenience; Linux is not a shipping
//     capture target in the spec).
//   - macOS: Chromium/Electron cannot provide system audio here. The real
//     mechanism is Core Audio process taps (CATapDescription, macOS 14.2+)
//     via a native module — tracked as MC-2. Until then we grant video only,
//     and the renderer falls back to mic-only capture.
// ---------------------------------------------------------------------------

function installDisplayMediaRequestHandler(ses) {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => {
        if (!sources.length) {
          console.error("[collective] no screen sources available; denying getDisplayMedia");
          callback({});
          return;
        }

        if (process.platform === "darwin") {
          console.log(
            "[collective] macOS: system audio is not available via getDisplayMedia loopback. " +
              "It requires the native Core Audio process-taps module (macOS 14.2+, MC-2) — " +
              "see docs/desktop-capture.md. Granting video only; capture proceeds mic-only."
          );
          callback({ video: sources[0] });
          return;
        }

        // Windows (WASAPI loopback) and Linux (PipeWire) expose system audio
        // to the renderer's getDisplayMedia via the "loopback" token.
        callback({ video: sources[0], audio: "loopback" });
      })
      .catch((err) => {
        console.error("[collective] desktopCapturer.getSources failed:", err);
        callback({});
      });
  });
}

// ---------------------------------------------------------------------------
// Permissions: deny everything except media capture.
//
// "media" covers getUserMedia (mic channel). "display-capture" is what
// Chromium raises for getDisplayMedia — it must be allowed for the
// display-media request handler above to ever be reached; it is media
// capture in the sense of this rule.
// ---------------------------------------------------------------------------

const ALLOWED_PERMISSIONS = new Set(["media", "display-capture"]);

function installPermissionRequestHandler(ses) {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) {
      console.log(`[collective] denied permission request: ${permission}`);
    }
    callback(allowed);
  });
}

// ---------------------------------------------------------------------------
// Global shortcut: CommandOrControl+Shift+R → show window + start capture.
// ---------------------------------------------------------------------------

function registerGlobalShortcut() {
  const ok = globalShortcut.register(CAPTURE_SHORTCUT, requestStartCapture);
  if (!ok) {
    console.error(`[collective] could not register global shortcut ${CAPTURE_SHORTCUT}`);
  }
}

// ---------------------------------------------------------------------------
// Tray. The icon is a generated 16x16 template PNG (black rounded "record"
// dot on transparency) built in-process — no binary assets in the repo.
// setTemplateImage(true) lets macOS tint it for light/dark menu bars.
// ---------------------------------------------------------------------------

function createTray() {
  let icon = nativeImage.createFromDataURL(trayIconDataURL());
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  } else {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip("Collective — meeting capture");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Start capture", click: requestStartCapture },
      { label: "Open Collective", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showMainWindow);
}

/**
 * Build a 16x16 RGBA PNG (a centered rounded dot, opaque black on transparent)
 * and return it as a data URL. Hand-rolled encoder: PNG signature + IHDR +
 * IDAT (zlib-deflated, filter 0 scanlines) + IEND, using only node:zlib.
 */
function trayIconDataURL() {
  const size = 16;
  const cx = 7.5;
  const cy = 7.5;
  const radius = 5.5;

  // Raw image data: each scanline prefixed with filter byte 0, pixels RGBA.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      // 1px soft edge so the dot doesn't look jagged.
      const alpha = d <= radius - 1 ? 255 : d >= radius ? 0 : Math.round((radius - d) * 255);
      const p = rowStart + 1 + x * 4;
      raw[p] = 0; // R (template images are black + alpha)
      raw[p + 1] = 0; // G
      raw[p + 2] = 0; // B
      raw[p + 3] = alpha; // A
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  return `data:image/png;base64,${png.toString("base64")}`;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on("before-quit", () => {
  quitting = true;
});

app.on("activate", () => {
  // macOS dock click.
  showMainWindow();
});

app.on("window-all-closed", () => {
  // Stay resident: the tray (and global shortcut) are the re-entry points.
  // Quit is explicit via the tray menu / Cmd+Q.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
