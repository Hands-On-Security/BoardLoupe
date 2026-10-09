/**
 * Node benchmark: parse / index / search timings on synthetic large boards.
 *   npm run bench             (sizes: 1k 10k 50k 100k 200k pins)
 * Writes bench/results-node.json and the generated boards to bench/boards/
 * (git-ignored) for the browser benchmark (tools/bench-browser.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPTIONS, parseFiles } from '../src/formats/registry';
import { buildScene } from '../src/scene/scene';
import { SearchIndex } from '../src/search/search';
import { largeBoard } from './fixtures/large';
import { writeBrd2, writeTvw } from './fixtures/writers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'bench/boards');
mkdirSync(outDir, { recursive: true });
const SIZES = (process.env.SIZES ?? '1000,10000,50000,100000,200000').split(',').map(Number);
const results: Record<string, unknown>[] = [];
const ms = (t: number) => +(performance.now() - t).toFixed(1);

for (const n of SIZES) {
  const b = largeBoard(n, 7);
  for (const [fmt, writer, ext] of [
    ['BRD2', writeBrd2, 'brd'],
    ['TVW', writeTvw, 'tvw'],
  ] as const) {
    const bytes = writer(b);
    const name = `synthetic-${n / 1000}k.${ext}`;
    writeFileSync(resolve(outDir, name), bytes);
    global.gc?.();
    const mem0 = process.memoryUsage().heapUsed;
    let t = performance.now();
    const out = parseFiles([{ name, bytes }], DEFAULT_OPTIONS);
    const parse = ms(t);
    if (!out.ok) throw new Error(`${name}: ${JSON.stringify(out.diagnostics)}`);
    const m = out.model!;
    t = performance.now();
    buildScene(m);
    const scene = ms(t);
    t = performance.now();
    const s = new SearchIndex(m);
    const index = ms(t);
    const qs = ['U1', 'GND', 'sig_12', 'C12', 'r99', 'U3.A1', 'pin 5', '3v3', 'sg1', 'vcc'];
    t = performance.now();
    for (let i = 0; i < 50; i++) s.query(qs[i % qs.length]);
    const query = +((performance.now() - t) / 50).toFixed(2);
    const heapMB = +((process.memoryUsage().heapUsed - mem0) / 1048576).toFixed(1);
    const row = { format: fmt, pins: m.pins.count, parts: m.parts.count, nets: m.nets.count, fileKB: Math.round(bytes.length / 1024), parseMs: parse, sceneMs: scene, searchIndexMs: index, queryMsAvg: query, heapMB };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
mkdirSync(resolve(root, 'bench'), { recursive: true });
writeFileSync(resolve(root, 'bench/results-node.json'), JSON.stringify({ node: process.version, date: new Date().toISOString(), results }, null, 2) + '\n');
