/**
 * Live-caption PCM streamer (design-spec §2.2, backlog IN-2).
 *
 * Taps the microphone's AudioContext graph, downsamples to 16 kHz mono
 * PCM16, and ships frames over a WebSocket to the server's streaming relay.
 * Runs alongside MediaRecorder (which keeps producing the archival webm) and
 * is strictly an enhancement: every failure path here degrades to
 * "no live captions" without touching the recording.
 */

const TARGET_RATE = 16_000;

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Average the source window for each output sample (cheap anti-aliasing).
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const sample = end > start ? sum / (end - start) : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

export interface PcmStreamer {
  setPaused(paused: boolean): void;
  stop(): void;
}

export function startPcmStream(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  wsUrl: string,
): PcmStreamer {
  let ws: WebSocket | null = null;
  let paused = false;
  let stopped = false;

  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onerror = () => {
      /* captions unavailable; recording unaffected */
    };
  } catch {
    ws = null;
  }

  // ScriptProcessorNode is deprecated but universally supported and needs no
  // separate worklet asset; ~4096 frames ≈ 85 ms at 48 kHz, well inside the
  // vendor's 50–1000 ms frame window.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (ev) => {
    if (stopped || paused || !ws || ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsampleTo16k(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
    ws.send(pcm.buffer);
  };
  source.connect(processor);
  // A muted sink keeps the processor pulled by the audio graph without
  // feeding the mic back to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);

  return {
    setPaused(p: boolean) {
      paused = p;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        processor.disconnect();
        sink.disconnect();
      } catch {
        /* graph already torn down */
      }
      ws?.close();
    },
  };
}
