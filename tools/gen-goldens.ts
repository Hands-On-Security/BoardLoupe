/**
 * Runs the reference C++ parsers (tools/obv-harness) on every manifest
 * fixture and stores their output in fixtures/golden/<id>.obv.json.
 *   npm run goldens        (builds the harness on first use)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManifestEntry } from './gen-fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harness = resolve(root, 'tools/obv-harness/build/obv-harness');
if (!existsSync(harness)) execFileSync(resolve(root, 'tools/obv-harness/build.sh'), { stdio: 'inherit' });
const manifest: ManifestEntry[] = JSON.parse(readFileSync(resolve(root, 'fixtures/manifest.json'), 'utf8'));
mkdirSync(resolve(root, 'fixtures/golden'), { recursive: true });
for (const e of manifest) {
  if (!e.obv) continue;
  const args = [e.obv, resolve(root, e.files[0])];
  if (e.key) args.push(e.key);
  let raw: string;
  try {
    raw = execFileSync(harness, args, { encoding: 'latin1', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    console.error(`✖ ${e.id}: reference parser crashed: ${(err as Error).message.split('\n')[0]}`);
    continue;
  }
  const g = JSON.parse(raw);
  writeFileSync(resolve(root, `fixtures/golden/${e.id}.obv.json`), JSON.stringify(g) + '\n');
  console.log(
    `${g.valid ? '✔' : '✖'} ${e.id}: valid=${g.valid} parts=${g.parts.length} pins=${g.pins.length} nails=${g.nails.length} outline=${g.format.length}/${g.outline_segments.length}${g.error ? ' error=' + g.error.slice(0, 120) : ''}`,
  );
}
