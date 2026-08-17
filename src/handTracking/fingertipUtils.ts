/**
 * Turning MediaPipe landmarks into exactly four control points.
 *
 * One hand  -> index, middle, ring and pinky tips (the four fingers the brief
 *              calls for; splaying them makes a natural quad).
 * Two hands -> index and pinky tip of each hand, which spans a much larger
 *              frame while staying inside the same landmark set.
 */

import type { HandLandmarkerResult } from './HandTracker';
import type { Vec2 } from '../utils/geometry';

export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
} as const;

export const SINGLE_HAND_TIPS = [
  LANDMARK.INDEX_TIP,
  LANDMARK.MIDDLE_TIP,
  LANDMARK.RING_TIP,
  LANDMARK.PINKY_TIP,
] as const;

export type TrackingMode = 'one-hand' | 'two-hand';

export interface FingertipReading {
  /** Exactly four points, normalised to the video frame (0..1). */
  points: [Vec2, Vec2, Vec2, Vec2];
  mode: TrackingMode;
  handCount: number;
}

interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

function tip(hand: NormalizedLandmark[], index: number): Vec2 | null {
  const l = hand[index];
  if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return null;
  return { x: l.x, y: l.y };
}

function handCentroidX(hand: NormalizedLandmark[]): number {
  let sum = 0;
  for (const l of hand) sum += l.x;
  return sum / Math.max(hand.length, 1);
}

/**
 * Pick the four control points from a detection result, or null when there
 * are not four usable fingertips.
 */
export function selectFingertips(result: HandLandmarkerResult | null): FingertipReading | null {
  const hands = result?.landmarks;
  if (!hands || hands.length === 0) return null;

  if (hands.length >= 2) {
    // Order hands left-to-right so the point identities stay stable frame to
    // frame even when MediaPipe reorders its output.
    const ordered = [...hands].sort((a, b) => handCentroidX(a) - handCentroidX(b));
    const a = ordered[0];
    const b = ordered[1];
    const pts = [
      tip(a, LANDMARK.INDEX_TIP),
      tip(a, LANDMARK.PINKY_TIP),
      tip(b, LANDMARK.INDEX_TIP),
      tip(b, LANDMARK.PINKY_TIP),
    ];
    if (pts.every((p): p is Vec2 => p !== null)) {
      return {
        points: pts as [Vec2, Vec2, Vec2, Vec2],
        mode: 'two-hand',
        handCount: hands.length,
      };
    }
  }

  const hand = hands[0];
  const pts = SINGLE_HAND_TIPS.map((i) => tip(hand, i));
  if (!pts.every((p): p is Vec2 => p !== null)) return null;

  return {
    points: pts as [Vec2, Vec2, Vec2, Vec2],
    mode: 'one-hand',
    handCount: hands.length,
  };
}

/** All 21 landmarks of the first hand, for optional skeleton rendering. */
export function primaryHandLandmarks(result: HandLandmarkerResult | null): Vec2[] | null {
  const hand = result?.landmarks?.[0];
  if (!hand) return null;
  return hand.map((l) => ({ x: l.x, y: l.y }));
}
