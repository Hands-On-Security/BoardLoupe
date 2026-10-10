// Inlines the Vite build output (one JS chunk + one CSS file) into a single
// self-contained dist/boardloupe.html and verifies that the result references
// no external resources and contains no unresolved imports.
import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(root, 'dist/.build');
const out = resolve(root, 'dist/boardloupe.html');

let html = readFileSync(resolve(buildDir, 'index.html'), 'utf8');
const files = readdirSync(buildDir, { recursive: true }).map(String);

// Inline <link rel="stylesheet" href="./app.css">
html = html.replace(/<link\s+rel="stylesheet"[^>]*href="\.?\/?([^"]+)"[^>]*>/g, (_, href) => {
  const css = readFileSync(resolve(buildDir, href), 'utf8');
  return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
});
// Inline <script type="module" crossorigin src="./app.js"></script>
html = html.replace(/<script\s+type="module"[^>]*src="\.?\/?([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const js = readFileSync(resolve(buildDir, src), 'utf8');
  // Escape any closing script tags inside string literals.
  return `<script type="module">\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
});
// Move the inlined module script to the end of <body> (DOM is ready when it runs).
const m = html.match(/<script type="module">[\s\S]*?<\/script>/);
if (m) {
  // Function replacements: the bundle contains `$` sequences that string
  // replacements would interpret as substitution patterns.
  html = html.replace(m[0], () => '');
  html = html.replace('</body>', () => `${m[0]}\n</body>`);
}

// Embed third-party licence notices (MIT/ISC require them to accompany copies).
{
  const licDir = resolve(root, 'LICENSES');
  const licenceFiles = readdirSync(licDir);
  const required = [
    'bzip2-1.0.8.txt', 'libarchive-3.7.2.txt', 'libarchive-js-2.0.2.txt',
    'libarchive-uc-regents.txt', 'openssl-1.0.2s.txt', 'xz-liblzma-5.2.11.txt',
    'zlib-1.3.txt',
  ];
  const missing = required.filter((f) => !licenceFiles.includes(f));
  if (missing.length) throw new Error(`Missing bundled archive licences: ${missing.join(', ')}`);
  const parts = licenceFiles
    .filter((f) => f.endsWith('.txt') && !f.startsWith('kicad-boardview'))
    .sort()
    .map((f) => `===== ${f.replace(/\.txt$/, '')} =====\n${readFileSync(resolve(licDir, f), 'utf8')}`);
  const own = readFileSync(resolve(root, 'LICENSE'), 'utf8');
  const text = `BoardLoupe — offline boardview viewer.\n${own}\n\nThird-party components bundled in this file and parser sources:\n\n${parts.join('\n\n')}`;
  // A non-executable script preserves licence text verbatim. HTML comments
  // cannot contain "--", which occurs in some upstream notices.
  if (/<\/script/i.test(text)) throw new Error('A licence notice contains a closing script tag');
  html = html.replace('<head>', () => `<head>\n<script type="text/plain" id="third-party-licences">\n${text}\n</script>`);
}

// ---- Verification ---------------------------------------------------------
const problems = [];
const extFiles = files.filter((f) => !['index.html', 'app.js', 'app.css'].includes(f) && statSync(resolve(buildDir, f)).isFile());
if (extFiles.length) problems.push(`Unexpected extra build outputs (would not be inlined): ${extFiles.join(', ')}`);
const checks = [
  [/<script[^>]+\bsrc\s*=/i, 'external <script src>'],
  [/<link[^>]+rel\s*=\s*["']?(?:stylesheet|preload|modulepreload|manifest)/i, 'external <link>'],
  // The value itself (after an optional quote) must start with data:. The quote is
  // matched explicitly so the regex cannot backtrack past it.
  [/<img[^>]+\bsrc\s*=\s*(?:"(?!data:)|'(?!data:)|(?!["'])(?!data:))/i, 'external <img src>'],
  [/@import\s+(?:url\()?["']?(?!data:)/i, 'CSS @import'],
  [/url\(\s*["']?(?:https?:)?\/\//i, 'CSS url() to remote resource'],
  [/\bimport\s*\(\s*["'`]\.{0,2}\//, 'dynamic import of a relative chunk'],
  [/\bfrom\s*["']\.{0,2}\/[^"']+\.js["']/, 'static import of a relative chunk'],
  [/navigator\.serviceWorker\.register/, 'service worker registration'],
  [/sourceMappingURL=(?!data:)/, 'external source map reference'],
  [/\bfetch\(\s*["'`]https?:/, 'fetch() to a remote URL'],
  [/new\s+WebSocket\s*\(/, 'WebSocket'],
  [/\bsendBeacon\s*\(/, 'sendBeacon'],
];
for (const [re, what] of checks) {
  const hit = html.match(re);
  if (hit) problems.push(`${what}: …${html.slice(Math.max(0, hit.index - 60), hit.index + 80).replace(/\s+/g, ' ')}…`);
}
// Every absolute http(s) URL must be in the allow-list of inert strings (XML namespaces, licence/docs links in comments/strings).
const allowed = [/^http:\/\/www\.w3\.org\//, /^https?:\/\/(?:github\.com|openboardview\.org|www\.w3\.org|www\.openssl\.org|tukaani\.org|kicad\.org|react\.dev|preactjs\.com|lucide\.dev|tailwindcss\.com|developer\.mozilla\.org|hands-on-security\.com|hos\.direct)\b/];
const urls = [...new Set(html.match(/https?:\/\/[^\s"'`)<>]+/g) ?? [])];
const unknownUrls = urls.filter((u) => !allowed.some((a) => a.test(u)));
if (unknownUrls.length) problems.push(`Unexpected absolute URLs in output (review): ${unknownUrls.slice(0, 10).join(' ')}`);

if (problems.length) {
  console.error('\n✖ Single-file verification failed:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

writeFileSync(out, html);
rmSync(buildDir, { recursive: true, force: true });
const size = Buffer.byteLength(html);
const gz = gzipSync(html, { level: 9 }).length;
// Headroom for the inlined libarchive WebAssembly (~1.8 MB base64) that opens
// RAR/7z. It ships in the single file but is only decoded/instantiated lazily,
// on the first RAR or 7z a user opens.
const BUDGET = 2.6 * 1024 * 1024;
console.log(`✔ dist/boardloupe.html  ${(size / 1024).toFixed(1)} KB  (gzip ${(gz / 1024).toFixed(1)} KB)  — no external references; ${urls.length} inert URL string(s)`);
if (size > BUDGET) {
  console.error(`✖ Size budget exceeded (${(BUDGET / 1024).toFixed(0)} KB)`);
  process.exit(1);
}
