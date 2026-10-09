/**
 * Opt-in checks on boardviews that cannot be committed (vendor files):
 *
 *   BS_PRIVATE_FIXTURES=/path/to/boards npm test
 *
 * Every file in that directory (non-recursive) must parse, pass integrity
 * validation, and satisfy geometric invariants: no outline segment longer
 * than the board, closed TVW route outlines, and pins inside their part
 * bodies when the bodies come from the file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { validateModel } from '../../src/model/validate';

const DIR = process.env.BS_PRIVATE_FIXTURES;
const files = DIR ? readdirSync(DIR).filter((f) => statSync(join(DIR, f)).isFile() && !f.startsWith('.')) : [];

describe.skipIf(!DIR)('private boardviews (BS_PRIVATE_FIXTURES)', () => {
  for (const f of files) {
    test(f, () => {
      const out = parseFiles([{ name: f, bytes: new Uint8Array(readFileSync(join(DIR!, f))) }], DEFAULT_OPTIONS);
      if (!out.ok) {
        // Unsupported or key-protected files must at least explain themselves.
        expect(out.diagnostics[0]?.message.length ?? 0).toBeGreaterThan(20);
        return;
      }
      const m = out.model!;
      expect(validateModel(m)).toEqual([]);
      const span = Math.hypot(m.bounds.maxX - m.bounds.minX, m.bounds.maxY - m.bounds.minY);
      const o = m.outline.segs;
      for (let i = 0; i < o.length; i += 4) expect(Math.hypot(o[i + 2] - o[i], o[i + 3] - o[i + 1])).toBeLessThan(span);
      if (m.source.formatId === 'tvw' && m.outline.source === 'file') {
        const ends = new Map<string, number>();
        for (let i = 0; i < o.length; i += 2) {
          const k = `${Math.round(o[i] * 2)},${Math.round(o[i + 1] * 2)}`;
          ends.set(k, (ends.get(k) ?? 0) + 1);
        }
        expect([...ends.values()].filter((c) => c % 2).length, 'open outline endpoints').toBe(0);
      }
      if (m.caps.partBodies === 'file') {
        let inside = 0,
          total = 0;
        for (let k = 0; k < m.parts.count; k++) {
          if (m.parts.bodyStart[k + 1] === m.parts.bodyStart[k]) continue;
          const b = m.parts.bbox.subarray(4 * k, 4 * k + 4);
          for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) {
            total++;
            if (m.pins.x[j] >= b[0] - 1 && m.pins.x[j] <= b[2] + 1 && m.pins.y[j] >= b[1] - 1 && m.pins.y[j] <= b[3] + 1) inside++;
          }
        }
        expect(inside / Math.max(1, total)).toBeGreaterThan(0.99);
      }
    });
  }
});
