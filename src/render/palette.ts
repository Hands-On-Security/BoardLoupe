/** Renderer colour palettes (RGBA 0-255). UI chrome colours live in CSS. */
export type RGBA = [number, number, number, number];

export interface Palette {
  bg: RGBA;
  grid: RGBA;
  outline: RGBA;
  outlineDerived: RGBA;
  body: RGBA;
  bodyDerived: RGBA;
  pad: RGBA;
  padTH: RGBA;
  padGnd: RGBA;
  padNC: RGBA;
  testpoint: RGBA;
  via: RGBA;
  /** Rim drawn at drill walls. */
  holeEdge: RGBA;
  selPart: RGBA;
  selNet: RGBA;
  selPin: RGBA;
  multi: RGBA;
  /** Bright ring drawn around every emphasised pad so a highlighted net stays
   * visible at any zoom (even when the pad itself is sub-pixel). */
  highlightHalo: RGBA;
  /** Distinct, high-contrast colours for a multi-net (bus) selection. */
  busColors: RGBA[];
  ratsnest: RGBA;
  measure: RGBA;
  label: string;
  labelDim: string;
  labelHalo: string;
  pinLabel: string;
  traceLayers: RGBA[];
}

export const DARK: Palette = {
  bg: [11, 14, 19, 255],
  grid: [26, 32, 42, 255],
  outline: [214, 178, 92, 255],
  outlineDerived: [120, 110, 90, 255],
  body: [92, 112, 138, 255],
  bodyDerived: [70, 84, 104, 255],
  pad: [196, 146, 82, 255],
  padTH: [176, 182, 192, 255],
  padGnd: [98, 118, 104, 255],
  padNC: [110, 96, 128, 255],
  testpoint: [226, 118, 196, 255],
  via: [120, 128, 140, 255],
  holeEdge: [158, 168, 182, 255],
  selPart: [255, 94, 110, 255],
  selNet: [66, 214, 255, 255],
  selPin: [255, 255, 255, 255],
  // Grouped / multi-selected parts: warm white, distinct from every bus colour.
  multi: [255, 234, 186, 255],
  highlightHalo: [255, 255, 255, 255],
  busColors: [
    [66, 214, 255, 255], // cyan
    [255, 158, 54, 255], // orange
    [120, 230, 120, 255], // green
    [255, 110, 196, 255], // pink
    [190, 150, 255, 255], // violet
    [250, 222, 74, 255], // yellow
    [96, 128, 255, 255], // blue
    [120, 236, 210, 255], // teal
  ],
  ratsnest: [66, 214, 255, 210],
  measure: [240, 184, 80, 255],
  label: 'rgba(226,232,240,0.95)',
  labelDim: 'rgba(160,172,190,0.75)',
  labelHalo: 'rgba(11,14,19,0.85)',
  pinLabel: 'rgba(20,16,10,0.95)',
  traceLayers: [
    [200, 70, 70, 110],
    [70, 120, 210, 110],
    [70, 180, 120, 90],
    [190, 120, 220, 90],
    [210, 170, 60, 90],
    [70, 190, 200, 90],
    [220, 110, 170, 90],
    [150, 150, 150, 90],
  ],
};

export const LIGHT: Palette = {
  bg: [244, 245, 247, 255],
  grid: [226, 229, 234, 255],
  outline: [150, 104, 20, 255],
  outlineDerived: [170, 160, 140, 255],
  body: [112, 128, 150, 255],
  bodyDerived: [150, 162, 178, 255],
  pad: [184, 112, 38, 255],
  padTH: [112, 120, 132, 255],
  padGnd: [120, 140, 124, 255],
  padNC: [150, 136, 168, 255],
  testpoint: [196, 60, 150, 255],
  via: [140, 146, 156, 255],
  holeEdge: [92, 100, 112, 255],
  selPart: [200, 30, 56, 255],
  selNet: [0, 122, 200, 255],
  selPin: [10, 10, 10, 255],
  multi: [36, 40, 52, 255],
  highlightHalo: [17, 20, 26, 255],
  busColors: [
    [0, 122, 200, 255], // blue
    [200, 92, 0, 255], // orange
    [24, 140, 70, 255], // green
    [196, 40, 150, 255], // magenta
    [120, 58, 214, 255], // violet
    [150, 110, 0, 255], // amber
    [0, 140, 160, 255], // teal
    [160, 40, 40, 255], // brick
  ],
  ratsnest: [0, 122, 200, 230],
  measure: [185, 119, 14, 255],
  label: 'rgba(20,26,36,0.95)',
  labelDim: 'rgba(70,80,96,0.8)',
  labelHalo: 'rgba(244,245,247,0.9)',
  pinLabel: 'rgba(255,255,255,0.95)',
  traceLayers: [
    [200, 60, 60, 120],
    [60, 100, 200, 120],
    [40, 150, 90, 100],
    [150, 90, 190, 100],
    [190, 140, 30, 100],
    [30, 150, 160, 100],
    [190, 80, 140, 100],
    [120, 120, 120, 100],
  ],
};

/** Stable pseudo-random colour for a net index (used in "colour by net" mode). */
export function netColor(i: number, light: boolean): RGBA {
  // Golden-angle hue spacing, fixed saturation/lightness.
  const h = ((i * 137.508) % 360) / 360;
  const s = 0.65,
    l = light ? 0.42 : 0.62;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255), 255];
}

export function rgbaCss(c: RGBA, alpha = c[3] / 255): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
