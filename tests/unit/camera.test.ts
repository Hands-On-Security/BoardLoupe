import { describe, expect, test } from 'vitest';
import { type View, fitView, panBy, screenToWorld, visibleWorldRect, worldToScreen, zoomAt } from '../../src/render/camera';

const base: View = { cx: 100, cy: 50, scale: 2, rot: 0, mirror: false, width: 800, height: 600 };
const ROTS = [0, 90, 180, 270] as const;

describe('camera transforms', () => {
  test('world → screen → world is the identity for every rotation and mirror', () => {
    for (const rot of ROTS)
      for (const mirror of [false, true]) {
        const v = { ...base, rot, mirror };
        for (const [x, y] of [
          [0, 0],
          [100, 50],
          [-1234.5, 987.25],
          [1e6, -1e6],
        ]) {
          const [sx, sy] = worldToScreen(v, x, y);
          const [wx, wy] = screenToWorld(v, sx, sy);
          expect(wx).toBeCloseTo(x, 6);
          expect(wy).toBeCloseTo(y, 6);
        }
      }
  });

  test('view centre maps to the canvas centre', () => {
    for (const rot of ROTS)
      for (const mirror of [false, true]) {
        const [sx, sy] = worldToScreen({ ...base, rot, mirror }, base.cx, base.cy);
        expect(sx).toBeCloseTo(400);
        expect(sy).toBeCloseTo(300);
      }
  });

  test('world Y points up on screen (CAD convention)', () => {
    const [, y0] = worldToScreen(base, 100, 50);
    const [, y1] = worldToScreen(base, 100, 60);
    expect(y1).toBeLessThan(y0);
  });

  test('mirror swaps left and right (bottom view)', () => {
    const [xr] = worldToScreen(base, 110, 50);
    const [xm] = worldToScreen({ ...base, mirror: true }, 110, 50);
    expect(xr).toBeGreaterThan(400);
    expect(xm).toBeLessThan(400);
  });

  test('rot 90 turns world +X into screen down (clockwise)', () => {
    const [sx, sy] = worldToScreen({ ...base, rot: 90 }, 110, 50);
    expect(sx).toBeCloseTo(400);
    expect(sy).toBeGreaterThan(300);
  });

  test('zoomAt keeps the world point under the cursor fixed', () => {
    for (const rot of ROTS)
      for (const mirror of [false, true]) {
        const v = { ...base, rot, mirror };
        const before = screenToWorld(v, 123, 456);
        const z = zoomAt(v, 3.7, 123, 456, 1e-6, 1e6);
        const after = screenToWorld(z, 123, 456);
        expect(after[0]).toBeCloseTo(before[0], 6);
        expect(after[1]).toBeCloseTo(before[1], 6);
        expect(z.scale).toBeCloseTo(v.scale * 3.7);
      }
  });

  test('zoom is clamped', () => {
    expect(zoomAt(base, 1000, 0, 0, 0.1, 10).scale).toBe(10);
    expect(zoomAt(base, 1e-9, 0, 0, 0.1, 10).scale).toBe(0.1);
  });

  test('panBy moves content with the pointer in every orientation', () => {
    for (const rot of ROTS)
      for (const mirror of [false, true]) {
        const v = { ...base, rot, mirror };
        const p = worldToScreen(v, 130, 70);
        const nv = panBy(v, 25, -40);
        const q = worldToScreen(nv, 130, 70);
        expect(q[0] - p[0]).toBeCloseTo(25);
        expect(q[1] - p[1]).toBeCloseTo(-40);
      }
  });

  test('fitView fits bounds inside the viewport with padding', () => {
    const b = { minX: -500, minY: 200, maxX: 1500, maxY: 900 };
    for (const rot of ROTS) {
      const v = fitView({ ...base, rot }, b, 20);
      const r = visibleWorldRect(v);
      expect(r.minX).toBeLessThanOrEqual(b.minX + 1e-6);
      expect(r.maxX).toBeGreaterThanOrEqual(b.maxX - 1e-6);
      expect(r.minY).toBeLessThanOrEqual(b.minY + 1e-6);
      expect(r.maxY).toBeGreaterThanOrEqual(b.maxY - 1e-6);
      // and actually uses the space (one dimension is tight)
      const tight = Math.min((r.maxX - r.minX) / (b.maxX - b.minX), (r.maxY - r.minY) / (b.maxY - b.minY));
      expect(tight).toBeLessThan(1.25);
    }
  });

  test('fitView handles degenerate (zero-size) bounds', () => {
    const v = fitView(base, { minX: 5, minY: 5, maxX: 5, maxY: 5 });
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });
});
