/**
 * A filter is one GLSL function plus a little metadata.
 *
 * To add a new one: drop a file next to this that exports a FilterDef whose
 * `glsl` defines `vec4 filterMain(vec2 local, vec2 screenUV)`, then add it to
 * the array in index.ts. Nothing else in the app needs to change — the
 * renderer compiles and caches programs on demand, and the UI builds its rail
 * from the registry.
 */
export interface FilterDef {
  /** Stable id, also used as the shader program cache key. */
  id: string;
  /** Shown on the selector chip and the on-screen label. */
  name: string;
  /** Body defining `vec4 filterMain(vec2 local, vec2 screenUV)`. */
  glsl: string;
  /** Two colours for the selector chip gradient. */
  accent: [string, string];
  /** Requires the mip chain (any use of srcLod above level 0). */
  needsMips?: boolean;
  /** Uses uTime — keeps the frame loop from idling when the hand is still. */
  animated?: boolean;
  /** Starting position of the intensity slider, 0..1. */
  defaultIntensity?: number;
}
