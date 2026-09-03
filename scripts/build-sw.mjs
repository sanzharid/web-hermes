// Generate dist/sw.js with a precache list of every built asset. Run after `vite build`.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = 'dist';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (!/sw\.js$/.test(p)) files.push('./' + relative(dist, p).split('\\').join('/'));
  }
})(dist);
const template = readFileSync('src/sw.template.js', 'utf8');
const version = `sift-${Date.now().toString(36)}`;
const out = template.replace('__PRECACHE__', JSON.stringify(files, null, 1)).replace('__VERSION__', version);
writeFileSync(join(dist, 'sw.js'), out);
console.log(`sw.js: ${files.length} files precached, version ${version}`);
