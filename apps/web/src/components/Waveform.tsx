import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/audio";

/**
 * Live waveform band (spec §7.3.2): amplitude-smoothed bars in
 * state.recording over linen, fed by an AnalyserNode. Under
 * prefers-reduced-motion it becomes a static level bar updated once a second.
 */
export function Waveform({ analyser, paused }: { analyser: AnalyserNode | null; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(canvas);
    const inkColor = styles.getPropertyValue("--c-state-recording").trim();
    const restColor = styles.getPropertyValue("--c-mist").trim();

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    resize();

    const buf = new Uint8Array(analyser.fftSize);
    const reduced = prefersReducedMotion();
    const barW = 3 * dpr;
    const gap = 2 * dpr;
    const slots = () => Math.max(8, Math.floor(canvas.width / (barW + gap)));
    let levels: number[] = [];
    let smoothed = 0;
    let raf = 0;
    let interval = 0;

    const rms = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    };

    const drawBars = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const n = slots();
      while (levels.length > n) levels.shift();
      ctx.fillStyle = inkColor;
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i] ?? 0;
        const bh = Math.max(2 * dpr, level * h * 0.9);
        const x = w - (levels.length - i) * (barW + gap);
        ctx.fillRect(x, (h - bh) / 2, barW, bh);
      }
    };

    const drawStaticLevel = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = restColor;
      ctx.fillRect(0, h / 2 - dpr, w, 2 * dpr);
      ctx.fillStyle = inkColor;
      const level = Math.min(1, rms() * 3);
      ctx.fillRect(0, h / 2 - 3 * dpr, w * level, 6 * dpr);
    };

    if (reduced) {
      drawStaticLevel();
      interval = window.setInterval(() => {
        if (!pausedRef.current) drawStaticLevel();
      }, 1000);
    } else {
      const frame = () => {
        if (!pausedRef.current) {
          const target = Math.min(1, rms() * 3);
          smoothed += (target - smoothed) * 0.25; // amplitude smoothing
          levels.push(smoothed);
          drawBars();
        }
        raf = window.requestAnimationFrame(frame);
      };
      raf = window.requestAnimationFrame(frame);
    }

    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(interval);
      window.removeEventListener("resize", onResize);
    };
  }, [analyser]);

  return (
    <div className="waveform-band" role="img" aria-label="Live audio level">
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
