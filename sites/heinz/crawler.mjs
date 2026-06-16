#!/usr/bin/env node
/**
 * Heinz page crawler.
 *
 * Fetches the production sitemap and generates pages.json, which the
 * compare.spec.ts test reads to know which pages to compare.
 *
 * Usage:
 *   node sites/heinz/crawler.mjs
 *   npm run crawl:heinz
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'site.config.json'), 'utf8'));

// ── HTTP helper ───────────────────────────────────────────────────────────────

/** Fetches a URL and returns the response body as a string (follows one redirect). */
function fetchText(url, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 3) { reject(new Error(`Too many redirects: ${url}`)); return; }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'KraftHeinz-Crawler/1.0' } }, (res) => {
      // Follow redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location, redirectDepth + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Extracts all <loc> values from a sitemap XML string. */
function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim());
}

/** Converts a URL path into a human-readable page name. */
function pathToName(baseName, relPath) {
  const segments = relPath.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length === 0) return `${baseName} Home`;
  return segments
    .map((s) => decodeURIComponent(s).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' › ');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const {
    name,
    previewBaseUrl,
    productionBaseUrl,
    sitemapPath = '/sitemap.xml',
    excludePatterns = [],
    maxPages = 0,
  } = config;

  const productionOrigin = new URL(productionBaseUrl).origin;
  const basePath         = new URL(productionBaseUrl).pathname.replace(/\/$/, '');
  const sitemapUrl       = productionBaseUrl.replace(/\/$/, '') + sitemapPath;

  console.log(`\nCrawling: ${name}`);
  console.log(`Sitemap:  ${sitemapUrl}\n`);

  // ── Fetch sitemap ─────────────────────────────────────────────────────────
  let allProductionUrls = [];

  try {
    const xml = await fetchText(sitemapUrl);

    if (xml.includes('<sitemapindex')) {
      // Sitemap index — fetch each child sitemap
      const subUrls = extractLocs(xml);
      console.log(`Sitemap index found — ${subUrls.length} child sitemap(s)`);
      for (const subUrl of subUrls) {
        try {
          process.stdout.write(`  Fetching: ${subUrl} … `);
          const subXml = await fetchText(subUrl);
          const locs   = extractLocs(subXml);
          allProductionUrls.push(...locs);
          console.log(`${locs.length} URL(s)`);
        } catch (e) {
          console.log(`skipped (${e.message})`);
        }
      }
    } else {
      allProductionUrls = extractLocs(xml);
    }

    console.log(`\nTotal URLs from sitemap: ${allProductionUrls.length}`);
  } catch (e) {
    console.warn(`\n⚠ Sitemap unavailable: ${e.message}`);
    console.warn('  Falling back to home page only.\n');
    allProductionUrls = [productionBaseUrl + '/'];
  }

  // ── Filter ────────────────────────────────────────────────────────────────
  const excludeRegexes = (excludePatterns ?? []).map((p) => new RegExp(p));

  const filtered = allProductionUrls.filter((url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== productionOrigin) return false;
      if (!parsed.pathname.startsWith(basePath)) return false;
      return !excludeRegexes.some((re) => re.test(parsed.pathname));
    } catch {
      return false;
    }
  });

  // Ensure home page is always present
  const homeUrl = productionBaseUrl.replace(/\/$/, '') + '/';
  const hasHome = filtered.some(
    (u) => u === homeUrl || u === productionBaseUrl || u === productionBaseUrl + '/',
  );
  if (!hasHome) filtered.unshift(homeUrl);

  // Deduplicate (preserve order)
  const unique = [...new Set(filtered)];

  // Apply page cap
  const limited = maxPages > 0 ? unique.slice(0, maxPages) : unique;

  // ── Build comparison pairs ────────────────────────────────────────────────
  const previewBase = previewBaseUrl.replace(/\/$/, '');

  const comparisons = limited.map((productionUrl) => {
    const pathname = new URL(productionUrl).pathname;
    const relPath  = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
    const previewUrl = previewBase + (relPath || '/');
    return {
      name: pathToName(name, relPath),
      previewUrl,
      productionUrl,
    };
  });

  // ── Write output ──────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, 'pages.json');
  fs.writeFileSync(outPath, JSON.stringify({ comparisons }, null, 2) + '\n', 'utf8');

  const rel = path.relative(process.cwd(), outPath);
  console.log(`\nWrote ${comparisons.length} page(s) → ${rel}\n`);
  comparisons.forEach((p, i) =>
    console.log(`  ${String(i + 1).padStart(3)}. ${p.name}`),
  );
  console.log('');
}

run().catch((e) => {
  console.error('\nCrawler failed:', e.message);
  process.exit(1);
});
