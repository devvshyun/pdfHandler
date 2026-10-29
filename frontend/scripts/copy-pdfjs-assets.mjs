// Copies pdf.js CMaps (needed for CJK text such as Korean) and standard fonts into public/.
import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'pdfjs');

for (const dir of ['cmaps', 'standard_fonts']) {
  const src = join(pdfjsRoot, dir);
  if (existsSync(src)) cpSync(src, join(target, dir), { recursive: true });
}
console.log(`pdf.js assets copied to ${target}`);
