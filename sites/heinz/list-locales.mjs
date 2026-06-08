#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagesPath = path.resolve(__dirname, 'pages.json');

if (!fs.existsSync(pagesPath)) {
  console.error('pages.json not found. Run: npm run crawl:heinz');
  process.exit(1);
}

const { comparisons } = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));

const LOCALE_RE = /^https?:\/\/[^/]+\/([a-z]{2}-[A-Z]{2})(\/|$)/;
const DEFAULT_KEY = 'default';

const counts = new Map();
for (const pair of comparisons) {
  const match = pair.productionUrl.match(LOCALE_RE);
  const key = match ? match[1] : DEFAULT_KEY;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const rows = [...counts.entries()].sort((a, b) => {
  if (a[0] === DEFAULT_KEY) return -1;
  if (b[0] === DEFAULT_KEY) return 1;
  return a[0].localeCompare(b[0]);
});

const localeWidth = Math.max('LOCALE'.length, ...rows.map(([k]) => k.length));
const countWidth  = Math.max('PAGES'.length,  ...rows.map(([, v]) => String(v).length));

const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

console.log(`${pad('LOCALE', localeWidth)}  ${padL('PAGES', countWidth)}`);
console.log(`${'-'.repeat(localeWidth)}  ${'-'.repeat(countWidth)}`);
for (const [locale, count] of rows) {
  console.log(`${pad(locale, localeWidth)}  ${padL(count, countWidth)}`);
}
console.log(`${'-'.repeat(localeWidth)}  ${'-'.repeat(countWidth)}`);
console.log(`${pad('TOTAL', localeWidth)}  ${padL(comparisons.length, countWidth)}`);
console.log(`\nLocales found: ${rows.length} (including "${DEFAULT_KEY}")`);
console.log('\nTo compare a single locale:  LOCALE=es-MX npm run compare:heinz');
console.log('To compare only the default:  LOCALE=default npm run compare:heinz');
console.log('To compare everything:        npm run compare:heinz');
