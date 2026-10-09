/**
 * Synthetic large boards for performance testing: a dense laptop-like
 * mainboard with BGAs, QFNs, connectors and many passives, with nets that
 * have realistic locality and a few huge power/ground nets.
 */
import { rng, type SrcBoard, type SrcPart, type SrcPin } from './source';

export function largeBoard(targetPins: number, seed = 1): SrcBoard {
  const r = rng(seed);
  const parts: SrcPart[] = [];
  const W = Math.max(4000, Math.sqrt(targetPins) * 120);
  const H = W * 0.62;
  let pins = 0;
  let netSeq = 0;
  const signalNets: string[] = [];
  const newNet = () => {
    const n = `SIG_${netSeq++}`;
    signalNets.push(n);
    return n;
  };
  const pickNet = (): string => {
    const x = r();
    if (x < 0.22) return 'GND';
    if (x < 0.27) return ['+3V3', '+1V8', '+5V', 'PP1V05_S0', 'VCC_CORE'][Math.floor(r() * 5)];
    if (x < 0.29) return '';
    // Locality: recent nets are much more likely.
    if (signalNets.length && r() < 0.7) return signalNets[Math.max(0, signalNets.length - 1 - Math.floor(r() * 40))];
    return newNet();
  };
  const idx = { U: 1, R: 1, C: 1, J: 1 };
  const place = (_prefix: keyof typeof idx, w: number, h: number): [number, number, 'T' | 'B'] => [r() * (W - w) + w / 2, r() * (H - h) + h / 2, r() < 0.35 ? 'B' : 'T'];
  while (pins < targetPins) {
    const kind = r();
    let p: SrcPart;
    if (kind < 0.015 && targetPins - pins > 400) {
      // BGA, 0.8 mm pitch
      const n = 12 + Math.floor(r() * 24);
      const pitch = 31.5;
      const [cx, cy, side] = place('U', n * pitch, n * pitch);
      const ps: SrcPin[] = [];
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) ps.push({ number: `${String.fromCharCode(65 + (i % 26))}${j + 1}`, name: '', x: Math.round(cx + (j - n / 2) * pitch), y: Math.round(cy + (i - n / 2) * pitch), net: pickNet(), w: 16, h: 16, shape: 'round', hole: 0, side });
      p = { name: `U${idx.U++}`, side, th: false, x: Math.round(cx), y: Math.round(cy), rot: 0, bbox: [cx - (n * pitch) / 2, cy - (n * pitch) / 2, cx + (n * pitch) / 2, cy + (n * pitch) / 2].map(Math.round) as [number, number, number, number], value: 'BGA', footprint: `BGA${n * n}`, pins: ps };
    } else if (kind < 0.06) {
      // QFN/QFP
      const n = 8 + Math.floor(r() * 25);
      const pitch = 19.7;
      const L = n * pitch;
      const [cx, cy, side] = place('U', L + 60, L + 60);
      const ps: SrcPin[] = [];
      let k = 1;
      for (let s = 0; s < 4; s++)
        for (let i = 0; i < n; i++) {
          const t = (i - n / 2) * pitch;
          const [x, y] = s === 0 ? [cx - L / 2 - 20, cy + t] : s === 1 ? [cx + t, cy - L / 2 - 20] : s === 2 ? [cx + L / 2 + 20, cy - t] : [cx - t, cy + L / 2 + 20];
          ps.push({ number: String(k++), name: '', x: Math.round(x), y: Math.round(y), net: pickNet(), w: s % 2 ? 10 : 30, h: s % 2 ? 30 : 10, shape: 'rect', hole: 0, side });
        }
      p = { name: `U${idx.U++}`, side, th: false, x: Math.round(cx), y: Math.round(cy), rot: 0, bbox: [cx - L / 2 - 40, cy - L / 2 - 40, cx + L / 2 + 40, cy + L / 2 + 40].map(Math.round) as [number, number, number, number], value: 'QFN', footprint: `QFN${4 * n}`, pins: ps };
    } else if (kind < 0.07) {
      // Connector (through-hole)
      const n = 10 + Math.floor(r() * 40);
      const [cx, cy, side] = place('J', n * 50, 100);
      const ps: SrcPin[] = [];
      for (let i = 0; i < n; i++)
        for (let row = 0; row < 2; row++) ps.push({ number: String(i * 2 + row + 1), name: '', x: Math.round(cx + (i - n / 2) * 50), y: Math.round(cy + (row ? 50 : 0)), net: pickNet(), w: 60, h: 60, shape: 'round', hole: 35, side });
      p = { name: `J${idx.J++}`, side, th: true, x: Math.round(cx), y: Math.round(cy), rot: 0, bbox: [cx - (n / 2) * 50 - 40, cy - 40, cx + (n / 2) * 50 + 40, cy + 90].map(Math.round) as [number, number, number, number], value: 'CONN', footprint: `HDR2x${n}`, pins: ps };
    } else {
      // Passive 0402/0201
      const [cx, cy, side] = place('R', 60, 30);
      const isCap = r() < 0.6;
      const vert = r() < 0.5;
      const d = 20;
      const a = pickNet();
      const b = r() < 0.5 ? 'GND' : pickNet();
      p = {
        name: isCap ? `C${idx.C++}` : `R${idx.R++}`,
        side,
        th: false,
        x: Math.round(cx),
        y: Math.round(cy),
        rot: vert ? 90 : 0,
        bbox: vert ? [cx - 12, cy - 30, cx + 12, cy + 30].map(Math.round) as [number, number, number, number] : [cx - 30, cy - 12, cx + 30, cy + 12].map(Math.round) as [number, number, number, number],
        value: isCap ? '100nF' : '10k',
        footprint: '0402',
        pins: [
          { number: '1', name: '', x: Math.round(vert ? cx : cx - d), y: Math.round(vert ? cy - d : cy), net: a, w: 20, h: 20, shape: 'rect', hole: 0, side },
          { number: '2', name: '', x: Math.round(vert ? cx : cx + d), y: Math.round(vert ? cy + d : cy), net: b, w: 20, h: 20, shape: 'rect', hole: 0, side },
        ],
      };
    }
    parts.push(p);
    pins += p.pins.length;
  }
  const outline: [number, number][] = [
    [0, 0],
    [Math.round(W), 0],
    [Math.round(W), Math.round(H)],
    [0, Math.round(H)],
  ];
  const outlineSegs = outline.map((p, i) => [...p, ...outline[(i + 1) % 4]] as [number, number, number, number]);
  const nets = [...new Set(parts.flatMap((p) => p.pins.map((q) => q.net)).filter(Boolean))];
  return { outline, outlineSegs, parts, nails: [], nets, traces: [], vias: [] };
}
