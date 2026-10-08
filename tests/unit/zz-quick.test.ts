import { test } from 'vitest';
import { parse } from '../helpers/load';
test('bbox ratio', () => {
  for (const f of ['fixtures/real/glasgow/glasgow-kicad-boardview.brd']) {
    const m = parse(f).model!;
    const rows: string[] = [];
    for (let k = 0; k < m.parts.count; k++) {
      const s = m.parts.pinStart[k], c = m.parts.pinCount[k];
      if (!c) continue;
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for (let j=s;j<s+c;j++){x0=Math.min(x0,m.pins.x[j]);x1=Math.max(x1,m.pins.x[j]);y0=Math.min(y0,m.pins.y[j]);y1=Math.max(y1,m.pins.y[j]);}
      const b = m.parts.bbox.subarray(4*k,4*k+4);
      rows.push(`${m.parts.name[k]} pins=${c} pinExt=${(x1-x0).toFixed(0)}x${(y1-y0).toFixed(0)} file=${(b[2]-b[0]).toFixed(0)}x${(b[3]-b[1]).toFixed(0)} contains=${b[0]<=x0&&b[2]>=x1&&b[1]<=y0&&b[3]>=y1}`);
    }
    console.log(rows.slice(0,40).join('\n'));
  }
});
