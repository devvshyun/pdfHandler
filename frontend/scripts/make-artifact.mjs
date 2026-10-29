// Packages dist/ (built with VITE_DEMO=1 VITE_PDFJS_ASSETS=json) for hosting as a claude.ai artifact:
// - pdfhandler.html: page content without the <html>/<head>/<body> skeleton the host adds
// - pdf.js CMaps as base64 JSON (the host does not serve .bcmap); standard fonts are dropped
// - raw control bytes and U+FFFD in bundles rewritten as escapes (all occur inside string literals),
//   since the host rejects text files that carry them
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = process.argv[2] ?? join(root, 'artifact');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'pdfjs', 'cmaps'), { recursive: true });
cpSync(join(dist, 'assets'), join(out, 'assets'), { recursive: true });

for (const file of readdirSync(join(out, 'assets'))) {
  if (!/\.m?js$/.test(file)) continue;
  const path = join(out, 'assets', file);
  const src = readFileSync(path, 'utf8');
  const fixed = src
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/\uFFFD/g, '\\ufffd');
  if (fixed !== src) writeFileSync(path, fixed, 'utf8');
}

for (const file of readdirSync(join(dist, 'pdfjs', 'cmaps'))) {
  if (!file.endsWith('.bcmap')) continue;
  const base64 = readFileSync(join(dist, 'pdfjs', 'cmaps', file)).toString('base64');
  writeFileSync(join(out, 'pdfjs', 'cmaps', file.replace(/\.bcmap$/, '.json')), JSON.stringify(base64));
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].trim();
const css = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)[1];
const js = /<script type="module"[^>]*src="([^"]+)"/.exec(html)[1];
writeFileSync(
  join(out, 'pdfhandler.html'),
  `<title>pdfHandler</title>\n<link rel="stylesheet" href="${css}">\n${body}\n<script type="module" src="${js}"></script>\n`,
);
console.log(`artifact bundle written to ${out}`);
