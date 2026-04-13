/**
 * Short notification tones using Web Audio (no assets). Safe no-op if unsupported.
 * Call after user gesture when possible so AudioContext is not suspended.
 */

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx || sharedCtx.state === "closed") {
      sharedCtx = new AC();
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

/** Resume AudioContext after a click (e.g. Start / Continue) so the first chime is not blocked. */
export async function primeAttentionAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  await ctx.resume().catch(() => undefined);
}

function beep(
  ctx: AudioContext,
  start: number,
  freq: number,
  duration: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  osc.connect(g);
  g.connect(ctx.destination);
  const t0 = start;
  const t1 = start + Math.min(0.04, duration * 0.15);
  const t2 = start + duration;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t1);
  g.gain.exponentialRampToValueAtTime(0.0001, t2);
  osc.start(t0);
  osc.stop(t2 + 0.02);
}

export async function playAttentionSound(kind: "step_complete" | "run_complete"): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }

  const t = ctx.currentTime;
  if (kind === "step_complete") {
    beep(ctx, t, 880, 0.14, 0.12);
    beep(ctx, t + 0.18, 660, 0.16, 0.1);
  } else {
    beep(ctx, t, 523.25, 0.12, 0.11);
    beep(ctx, t + 0.13, 659.25, 0.12, 0.11);
    beep(ctx, t + 0.26, 783.99, 0.18, 0.12);
  }
}
