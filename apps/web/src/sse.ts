/**
 * Fetch-based Server-Sent Events client. EventSource cannot carry the
 * Authorization header the API requires, so we stream the response body and
 * parse SSE frames ourselves. Reconnects with a small backoff until aborted.
 */
import { authHeaders } from "./api";

export interface SseHandlers {
  onEvent: (event: string, data: unknown) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

const RECONNECT_MS = 2000;

export function subscribeSse(path: string, handlers: SseHandlers, signal: AbortSignal): void {
  void runLoop(path, handlers, signal);
}

async function runLoop(path: string, handlers: SseHandlers, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(path, {
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      handlers.onOpen?.();
      await readStream(res.body, handlers, signal);
    } catch (err) {
      if (signal.aborted) return;
      handlers.onError?.(err);
    }
    if (signal.aborted) return;
    await delay(RECONNECT_MS, signal);
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
    handlers.onEvent(eventName, data);
    eventName = "message";
    dataLines = [];
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) return;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        dispatch();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      // comments (":") and other fields are ignored
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
