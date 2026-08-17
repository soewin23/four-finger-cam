/**
 * Filter registry.
 *
 * Adding a filter is one import + one array entry. The renderer compiles
 * programs lazily on first use and caches them by id; the selector UI is
 * generated from this list.
 */
import type { FilterDef } from './types';

import { neon } from './neon';
import { thermal } from './thermal';
import { negative } from './negative';
import { vhs } from './vhs';
import { cyberpunk } from './cyberpunk';
import { glitch } from './glitch';
import { blackwhite } from './blackwhite';
import { duotone } from './duotone';
import { pixelate } from './pixelate';
import { blur } from './blur';
import { mirror } from './mirror';
import { kaleidoscope } from './kaleidoscope';
import { heatwave } from './heatwave';
import { posterize } from './posterize';
import { rgbsplit } from './rgbsplit';

export type { FilterDef } from './types';

export const FILTERS: FilterDef[] = [
  neon,
  thermal,
  negative,
  vhs,
  cyberpunk,
  glitch,
  blackwhite,
  duotone,
  pixelate,
  blur,
  mirror,
  kaleidoscope,
  heatwave,
  posterize,
  rgbsplit,
];

export const DEFAULT_FILTER_ID = neon.id;

export function getFilter(id: string): FilterDef {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}
