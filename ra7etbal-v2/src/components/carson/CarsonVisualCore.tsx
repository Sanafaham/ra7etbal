import { useEffect, useRef } from "react";
import {
  CARSON_VISUAL_LABELS,
  type CarsonVisualState,
} from "./carson-visual-state";

interface CarsonVisualCoreProps {
  state: CarsonVisualState;
  active: boolean;
  immersive?: boolean;
  getInputByteFrequencyData?: () => Uint8Array;
  getOutputByteFrequencyData?: () => Uint8Array;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
}

const PALETTE: Record<CarsonVisualState, [number, number, number]> = {
  idle: [160, 137, 91],
  listening: [91, 126, 113],
  thinking: [151, 132, 96],
  working: [186, 147, 76],
  speaking: [205, 167, 91],
  complete: [103, 145, 119],
  error: [158, 82, 75],
};

function signalEnergy(data: Uint8Array | undefined, volume: number | undefined): number {
  if (!data?.length) return Math.min(1, Math.max(0, volume ?? 0));
  let sum = 0;
  const start = Math.floor(data.length * 0.05);
  const end = Math.max(start + 1, Math.floor(data.length * 0.62));
  for (let index = start; index < end; index += 1) sum += data[index];
  const spectrum = sum / ((end - start) * 255);
  return Math.min(1, Math.max(spectrum * 1.55, volume ?? 0));
}

export default function CarsonVisualCore({
  state,
  active,
  immersive = false,
  getInputByteFrequencyData,
  getOutputByteFrequencyData,
  getInputVolume,
  getOutputVolume,
}: CarsonVisualCoreProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastTime = performance.now();
    let smoothedEnergy = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const safeRead = (reader?: () => Uint8Array) => {
      try { return reader?.(); } catch { return undefined; }
    };
    const safeVolume = (reader?: () => number) => {
      try { return reader?.(); } catch { return undefined; }
    };

    const draw = (now: number) => {
      const visualState = stateRef.current;
      const elapsed = Math.min(50, now - lastTime);
      lastTime = now;
      const t = now / 1000;
      const [r, g, b] = PALETTE[visualState];
      const liveEnergy = visualState === "speaking"
        ? signalEnergy(safeRead(getOutputByteFrequencyData), safeVolume(getOutputVolume))
        : visualState === "listening"
          ? signalEnergy(safeRead(getInputByteFrequencyData), safeVolume(getInputVolume))
          : 0;
      smoothedEnergy += (liveEnergy - smoothedEnergy) * Math.min(1, elapsed / 90);

      context.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const minSide = Math.min(width, height);
      const baseRadius = minSide * 0.205;
      const reduced = reducedMotion.matches;
      const ambient = reduced ? 0 : Math.sin(t * 0.72) * 0.018;
      const response = smoothedEnergy * 0.18;
      const statePulse = visualState === "working"
        ? (reduced ? 0 : Math.sin(t * 3.1) * 0.035)
        : visualState === "thinking"
          ? (reduced ? 0 : Math.sin(t * 1.8) * 0.022)
          : 0;
      const radius = baseRadius * (1 + ambient + response + statePulse);

      const atmosphere = context.createRadialGradient(cx, cy, radius * 0.15, cx, cy, minSide * 0.48);
      atmosphere.addColorStop(0, `rgba(${r},${g},${b},${0.17 + smoothedEnergy * 0.08})`);
      atmosphere.addColorStop(0.48, `rgba(${r},${g},${b},0.035)`);
      atmosphere.addColorStop(1, "rgba(8,10,10,0)");
      context.fillStyle = atmosphere;
      context.fillRect(0, 0, width, height);

      context.save();
      context.translate(cx, cy);
      const rotation = reduced ? 0 : t * (visualState === "working" ? 0.32 : visualState === "thinking" ? 0.18 : 0.07);
      context.rotate(rotation);

      for (let ring = 0; ring < 3; ring += 1) {
        const ringRadius = radius * (1.38 + ring * 0.25);
        context.beginPath();
        context.arc(0, 0, ringRadius, -1.15 + ring * 0.75, 0.72 + ring * 0.8);
        context.strokeStyle = `rgba(${r},${g},${b},${0.16 - ring * 0.035})`;
        context.lineWidth = ring === 0 ? 1.2 : 0.7;
        context.stroke();
      }

      const facets = 12;
      context.beginPath();
      for (let index = 0; index < facets; index += 1) {
        const angle = (index / facets) * Math.PI * 2;
        const irregularity = 1 + Math.sin(index * 2.17 + t * (reduced ? 0 : 0.55)) * 0.035;
        const pointRadius = radius * irregularity;
        const x = Math.cos(angle) * pointRadius;
        const y = Math.sin(angle) * pointRadius;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath();
      const coreFill = context.createRadialGradient(-radius * 0.24, -radius * 0.3, radius * 0.04, 0, 0, radius * 1.2);
      coreFill.addColorStop(0, `rgba(${Math.min(255, r + 65)},${Math.min(255, g + 58)},${Math.min(255, b + 42)},0.96)`);
      coreFill.addColorStop(0.28, `rgba(${r},${g},${b},0.78)`);
      coreFill.addColorStop(0.72, `rgba(${Math.round(r * 0.45)},${Math.round(g * 0.45)},${Math.round(b * 0.45)},0.92)`);
      coreFill.addColorStop(1, "rgba(8,11,11,0.98)");
      context.fillStyle = coreFill;
      context.shadowColor = `rgba(${r},${g},${b},0.46)`;
      context.shadowBlur = radius * (0.34 + smoothedEnergy * 0.42);
      context.fill();
      context.shadowBlur = 0;
      context.strokeStyle = `rgba(${Math.min(255, r + 65)},${Math.min(255, g + 65)},${Math.min(255, b + 65)},0.42)`;
      context.lineWidth = 0.9;
      context.stroke();

      context.beginPath();
      context.arc(-radius * 0.15, -radius * 0.18, radius * (0.23 + smoothedEnergy * 0.08), 0, Math.PI * 2);
      context.fillStyle = `rgba(255,247,222,${0.12 + smoothedEnergy * 0.17})`;
      context.fill();
      context.restore();

      if (!document.hidden && (!reduced || frame === 0)) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    const resume = () => {
      if (document.hidden || frame) return;
      lastTime = performance.now();
      frame = window.requestAnimationFrame(draw);
    };
    const handleVisibility = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      } else {
        resume();
      }
    };
    const handleMotionChange = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      resume();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    document.addEventListener("visibilitychange", handleVisibility);
    reducedMotion.addEventListener("change", handleMotionChange);
    resume();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotion.removeEventListener("change", handleMotionChange);
    };
  }, [active, getInputByteFrequencyData, getInputVolume, getOutputByteFrequencyData, getOutputVolume, state]);

  return (
    <section
      className={
        "relative mx-auto flex w-full flex-col items-center overflow-hidden " +
        (immersive
          ? "h-full max-w-[560px] bg-transparent px-2 pb-2 pt-0"
          : "max-w-[420px] rounded-[28px] border border-white/10 bg-[#0b0e0e] px-4 pb-4 pt-3 shadow-[0_24px_80px_-36px_rgba(10,12,12,0.85)]")
      }
      aria-label={`Carson is ${CARSON_VISUAL_LABELS[state].toLowerCase()}`}
      data-carson-visual-state={state}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(173,151,103,0.10),transparent_48%),linear-gradient(180deg,rgba(255,255,255,0.025),transparent_38%)]" />
      <canvas
        ref={canvasRef}
        className={
          immersive
            ? "relative min-h-[260px] w-full flex-1 sm:min-h-[320px]"
            : "relative h-[176px] w-full sm:h-[210px]"
        }
        aria-hidden="true"
      />
      <div className="relative -mt-1 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 backdrop-blur-sm">
        <span
          className="h-1.5 w-1.5 rounded-full bg-[#b99a5a] shadow-[0_0_10px_rgba(185,154,90,0.85)]"
          aria-hidden="true"
        />
        <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#e8dfcc]/80">
          {CARSON_VISUAL_LABELS[state]}
        </span>
      </div>
    </section>
  );
}
