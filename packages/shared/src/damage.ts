import { HIT_SPEED_THRESHOLD } from "./simulation";

const DAMAGE_SCALE = 10;

/** One entry per ragdoll bone, in ragdoll.ts order. The head is worth the most. */
export const BODY_PARTS: readonly { name: string; multiplier: number }[] = [
  { name: "Pelvis", multiplier: 1 },
  { name: "Lower back", multiplier: 1.1 },
  { name: "Abdomen", multiplier: 1.1 },
  { name: "Chest", multiplier: 1.3 },
  { name: "Neck", multiplier: 2 },
  { name: "Head", multiplier: 3 },
  { name: "Left thigh", multiplier: 0.8 },
  { name: "Left shin", multiplier: 0.7 },
  { name: "Right thigh", multiplier: 0.8 },
  { name: "Right shin", multiplier: 0.7 },
  { name: "Left upper arm", multiplier: 0.6 },
  { name: "Left forearm", multiplier: 0.5 },
  { name: "Right upper arm", multiplier: 0.6 },
  { name: "Right forearm", multiplier: 0.5 },
];

/** Damage from one impact: zero at the hit threshold, growing with speed². */
export function damageForHit(bone: number, speed: number) {
  const excess = Math.max(0, speed - HIT_SPEED_THRESHOLD);
  return BODY_PARTS[bone].multiplier * DAMAGE_SCALE * excess * excess;
}

/** The score for a run: total damage, rounded to a whole number. */
export function scoreOf(damage: readonly number[]) {
  return Math.round(damage.reduce((sum, value) => sum + value, 0));
}
