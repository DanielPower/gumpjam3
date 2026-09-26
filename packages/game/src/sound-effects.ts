import { HIT_SPEED_THRESHOLD } from "@stairs/shared/simulation";

/**
 * Sound effects, synthesised with Web Audio rather than recorded.
 *
 * Impacts are made to order, so every hit
 * can follow how hard it was and what took it:
 * - the head (and neck) knock: a slightly higher, hollower thump;
 * - the torso thuds: a deep, heavy body blow;
 * - arms and legs thump: lighter and shorter.
 * Everything is muffled, as flesh is: the noise is low-passed, and only opens
 * up for harder hits. Harder hits are also louder, and the hardest add a crack.
 */

/** Hits this much over the damage threshold (m/s) sound as hard as they get. */
const SPEED_FOR_LOUDEST = 10;
/** The same body part won't sound again sooner than this (seconds), so sliding doesn't buzz. */
const PART_COOLDOWN = 0.07;
/** At most this many hits sound at once; the rest are drowned out anyway. */
const MAX_VOICES = 10;
const VOICE_SECONDS = 0.5;
const MUTE_KEY = "stairs.muted";

type Kind = "head" | "torso" | "limb";
/** Ragdoll bones in ragdoll.ts order. */
const KIND_OF_BONE: readonly Kind[] = [
  "torso", "torso", "torso", "torso", "head", "head",
  "limb", "limb", "limb", "limb", "limb", "limb", "limb", "limb",
];

export type ImpactHit = { bone: number; speed: number };

let context: AudioContext | null = null;
let output: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";
const lastPlayed = new Map<number, number>();
const voiceEnds: number[] = [];

/**
 * Browsers only start audio after the player interacts, so make (or wake) the
 * audio context on the first press anywhere. Kept for the page's lifetime,
 * across level switches.
 */
function wake() {
  if (!context) {
    context = new AudioContext();
    // A compressor keeps a pile-up of hits from clipping.
    const compressor = new DynamicsCompressorNode(context, { threshold: -18, ratio: 6, attack: 0.002, release: 0.15 });
    output = new GainNode(context, { gain: muted ? 0 : 0.8 });
    output.connect(compressor).connect(context.destination);
    noise = new AudioBuffer({ length: context.sampleRate, sampleRate: context.sampleRate, numberOfChannels: 1 });
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  if (context.state === "suspended") void context.resume();
}
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, wake, { capture: true });

export function isMuted() {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  output?.gain.setTargetAtTime(value ? 0 : 0.8, output.context.currentTime, 0.02);
}

/**
 * Sound a batch of hits (e.g. everything from one frame's physics steps),
 * `pan` giving each one's place left to right (-1 to 1). Only the hardest hit
 * per body part in a batch sounds.
 */
export function playImpacts<Hit extends ImpactHit>(hits: readonly Hit[], pan: (hit: Hit) => number = () => 0) {
  if (!context || !output || !noise || muted || context.state !== "running") return;
  const hardest = new Map<number, Hit>();
  for (const hit of hits) {
    if (hit.speed > (hardest.get(hit.bone)?.speed ?? 0)) hardest.set(hit.bone, hit);
  }
  const now = context.currentTime;
  while (voiceEnds.length && voiceEnds[0] <= now) voiceEnds.shift();
  const loudestFirst = [...hardest.values()].sort((a, b) => b.speed - a.speed);
  for (const hit of loudestFirst) {
    if (voiceEnds.length >= MAX_VOICES) break;
    if (now - (lastPlayed.get(hit.bone) ?? -Infinity) < PART_COOLDOWN) continue;
    lastPlayed.set(hit.bone, now);
    voiceEnds.push(now + VOICE_SECONDS);
    voiceEnds.sort((a, b) => a - b);
    const intensity = Math.min(1, Math.max(0, (hit.speed - HIT_SPEED_THRESHOLD) / SPEED_FOR_LOUDEST));
    impact(context, output, noise, KIND_OF_BONE[hit.bone] ?? "limb", intensity, Math.max(-1, Math.min(1, pan(hit))));
  }
}

/**
 * An armed mine's beep: a short electronic blip, or for the `final` one just
 * before it goes off, a higher, longer one. `pan` is its place left to right (-1 to 1).
 */
export function playBeep(final: boolean, pan = 0) {
  if (!context || !output || muted || context.state !== "running") return;
  const t = context.currentTime;
  const [frequency, length] = final ? [2100, 0.14] : [1300, 0.07];
  const oscillator = new OscillatorNode(context, { type: "square", frequency });
  // Take the edge off the square wave, so it beeps rather than buzzes.
  const filter = new BiquadFilterNode(context, { type: "lowpass", frequency: frequency * 2.5 });
  const gain = new GainNode(context, { gain: 0 });
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.18, t + 0.005);
  gain.gain.setValueAtTime(0.18, t + length - 0.015);
  gain.gain.linearRampToValueAtTime(0, t + length);
  oscillator
    .connect(filter)
    .connect(gain)
    .connect(new StereoPannerNode(context, { pan: Math.max(-1, Math.min(1, pan)) * 0.7 }))
    .connect(output);
  oscillator.start(t);
  oscillator.stop(t + length + 0.02);
}

export type LoopingSound = { setPan(pan: number): void; stop(): void };

/**
 * A thruster's roar: a rumble of low noise with a hiss on top, crackling a
 * little, until it's stopped (fading out as the fuel runs dry). Null if sound
 * is off or not started yet.
 */
export function startThruster(pan = 0): LoopingSound | null {
  if (!context || !output || !noise || muted || context.state !== "running") return null;
  const ctx = context;
  const t = ctx.currentTime;
  const source = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const rumble = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 700, Q: 0.8 });
  const rumbleGain = new GainNode(ctx, { gain: 0.5 });
  const hiss = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2600, Q: 0.8 });
  const hissGain = new GainNode(ctx, { gain: 0.08 });
  // The crackle: the level wobbling quickly and unevenly.
  const level = new GainNode(ctx, { gain: 0 });
  const crackle = new OscillatorNode(ctx, { type: "sawtooth", frequency: 19 });
  const crackleDepth = new GainNode(ctx, { gain: 0.08 });
  crackle.connect(crackleDepth).connect(level.gain);
  const panner = new StereoPannerNode(ctx, { pan: Math.max(-1, Math.min(1, pan)) * 0.7 });
  source.connect(rumble).connect(rumbleGain).connect(level);
  source.connect(hiss).connect(hissGain).connect(level);
  level.connect(panner).connect(output);
  level.gain.setValueAtTime(0, t);
  level.gain.linearRampToValueAtTime(0.35, t + 0.08);
  source.start(t, Math.random() * (noise.duration - 0.1));
  crackle.start(t);
  let stopped = false;
  return {
    setPan: (value) => panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, value)) * 0.7, ctx.currentTime, 0.05),
    stop: () => {
      if (stopped) return;
      stopped = true;
      const now = ctx.currentTime;
      level.gain.cancelScheduledValues(now);
      level.gain.setTargetAtTime(0, now, 0.08);
      source.stop(now + 0.5);
      crackle.stop(now + 0.5);
    },
  };
}

/** A little variety, so repeated hits don't sound mechanical. */
const vary = (value: number, amount = 0.08) => value * (1 + (Math.random() * 2 - 1) * amount);

function impact(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer, kind: Kind, intensity: number, pan: number) {
  const t = ctx.currentTime;
  // Loudness grows quickly at first, so light taps are still audible.
  const volume = 0.2 + 0.8 * Math.sqrt(intensity);
  const out = new GainNode(ctx, { gain: volume });
  out.connect(new StereoPannerNode(ctx, { pan: pan * 0.7 })).connect(destination);

  // The body of the sound: a pitch that drops fast, like a struck drum.
  const tone = {
    head: { from: 210, to: 105, decay: 0.12, type: "sine", level: 1 },
    torso: { from: 110, to: 45, decay: 0.22, type: "sine", level: 1 },
    limb: { from: 140, to: 60, decay: 0.12, type: "sine", level: 0.9 },
  }[kind];
  const oscillator = new OscillatorNode(ctx, { type: tone.type as OscillatorType });
  oscillator.frequency.setValueAtTime(vary(tone.from), t);
  oscillator.frequency.exponentialRampToValueAtTime(vary(tone.to), t + tone.decay);
  const toneGain = new GainNode(ctx, { gain: 0 });
  toneGain.gain.setValueAtTime(0, t);
  toneGain.gain.linearRampToValueAtTime(tone.level, t + 0.003);
  toneGain.gain.exponentialRampToValueAtTime(0.001, t + tone.decay * 1.6);
  oscillator.connect(toneGain).connect(out);
  oscillator.start(t);
  oscillator.stop(t + VOICE_SECONDS);

  // The contact: a short, muffled burst of noise, opening up for harder hits.
  const texture = {
    head: { filter: "lowpass", frequency: 550 + 1300 * intensity, q: 1.2, decay: 0.05, level: 0.6 },
    torso: { filter: "lowpass", frequency: 300 + 900 * intensity, q: 0.7, decay: 0.1, level: 0.8 },
    limb: { filter: "lowpass", frequency: 400 + 1100 * intensity, q: 0.7, decay: 0.06, level: 0.6 },
  }[kind];
  burst(ctx, out, noise, t, texture.filter as BiquadFilterType, vary(texture.frequency), texture.q, texture.decay, texture.level);

  // The hardest hits crack.
  if (intensity > 0.55) burst(ctx, out, noise, t + 0.004, "highpass", vary(2800), 0.8, 0.035, (intensity - 0.55) * 1.4);
}

function burst(
  ctx: AudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  t: number,
  type: BiquadFilterType,
  frequency: number,
  q: number,
  decay: number,
  level: number,
) {
  // Start somewhere random in the noise, so bursts aren't identical.
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const filter = new BiquadFilterNode(ctx, { type, frequency, Q: q });
  const gain = new GainNode(ctx, { gain: 0 });
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, t + decay * 2.5);
  source.connect(filter).connect(gain).connect(destination);
  source.start(t, Math.random() * (noise.duration - 0.5));
  source.stop(t + decay * 3);
}
