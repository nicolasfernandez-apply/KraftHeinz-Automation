#!/usr/bin/env node
/**
 * Audits the fr-CA recettes pages on kraftheinz.com.
 *
 * For each brand recettes page found in the sitemap, the script:
 *   1. Loads the page in Chromium.
 *   2. Clicks "Afficher d'autres résultats" until the button is gone,
 *      waiting between clicks for new cards to render.
 *   3. Inspects every tagline element matching the configured class set.
 *      Taglines reading "Recettes" are correct; "Recipes" is reported.
 *
 * The report lists the recipe title, the offending tagline text,
 * and the card's URL.
 *
 * Usage:
 *   node sites/heinz/recettes-audit.mjs
 *   npm run audit:heinz-recettes
 */

import { chromium } from '@playwright/test';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SITEMAP_URL  = 'https://www.kraftheinz.com/sitemap.xml';
const RECETTES_RE  = /^https:\/\/www\.kraftheinz\.com\/fr-CA\/[^/]+\/recettes\/?$/;
const LOAD_MORE_RE = /Afficher d['’]autres résultats/i;

// Tagline class set. Using [class~="…"] avoids escaping the `.` in `mt-0.5`.
const TAGLINE_CLASSES = [
  'paragraph-xsmall',
  'paragraph-prominent',
  'tagline',
  'text-skin-subhead-primary',
  'mt-0.5',
  'mb-2',
];
const TAGLINE_SELECTOR = TAGLINE_CLASSES.map((c) => `[class~="${c}"]`).join('');

// ── HTTP / sitemap helpers ────────────────────────────────────────────────────

function fetchText(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error(`Too many redirects: ${url}`));
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'KraftHeinz-Audit/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(new URL(res.headers.location, url).toString(), depth + 1)
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

const extractLocs = (xml) =>
  [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => m[1].trim());

async function collectSitemapUrls(rootUrl) {
  const xml = await fetchText(rootUrl);
  const locs = extractLocs(xml);
  if (!xml.includes('<sitemapindex')) return locs;

  const all = [];
  for (const sub of locs) {
    try {
      const subXml = await fetchText(sub);
      // Some children may themselves be indexes — recurse one level.
      if (subXml.includes('<sitemapindex')) {
        for (const sub2 of extractLocs(subXml)) {
          try { all.push(...extractLocs(await fetchText(sub2))); }
          catch (e) { console.warn(`  skipped ${sub2}: ${e.message}`); }
        }
      } else {
        all.push(...extractLocs(subXml));
      }
    } catch (e) {
      console.warn(`  skipped ${sub}: ${e.message}`);
    }
  }
  return all;
}

// ── Page audit ────────────────────────────────────────────────────────────────

async function clickLoadMoreUntilGone(page) {
  for (let i = 0; i < 200; i++) {
    const btn = page.getByRole('button', { name: LOAD_MORE_RE }).first();
    let visible = false;
    try { visible = (await btn.count()) > 0 && (await btn.isVisible()); } catch { visible = false; }
    if (!visible) return i;

    const beforeCount = await page.locator(TAGLINE_SELECTOR).count();
    try {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
    } catch (e) {
      console.warn(`    load-more click failed: ${e.message}`);
      return i;
    }

    // Wait for either: more cards rendered, or the button to disappear.
    await Promise.race([
      page.waitForFunction(
        ({ sel, before }) => document.querySelectorAll(sel).length > before,
        { sel: TAGLINE_SELECTOR, before: beforeCount },
        { timeout: 20_000 },
      ).catch(() => null),
      page.waitForFunction(
        (re) => {
          const rx = new RegExp(re, 'i');
          return !Array.from(document.querySelectorAll('button'))
            .some((b) => rx.test(b.textContent || ''));
        },
        LOAD_MORE_RE.source,
        { timeout: 20_000 },
      ).catch(() => null),
    ]);
    await page.waitForTimeout(250); // small settle
  }
  return 200;
}

async function collectTaglines(page) {
  return page.$$eval(TAGLINE_SELECTOR, (els) =>
    els.map((el) => {
      const text = (el.textContent || '').trim();

      // Card URL: nearest ancestor <a> with href (resolved to absolute).
      const anchor = el.closest('a[href]');
      const href = anchor ? anchor.href : null;

      // Title: the previous sibling element (a <p>), with fallback to any
      // preceding sibling that has visible text.
      const takeText = (node) => {
        const t = (node?.textContent || '').trim();
        return t.length ? t : null;
      };
      let title = null;
      let prev = el.previousElementSibling;
      while (prev && !takeText(prev)) prev = prev.previousElementSibling;
      if (prev) title = takeText(prev);

      return { text, href, title };
    }),
  );
}

async function auditPage(page, url) {
  console.log(`\n→ ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Best-effort dismiss of any cookie banner.
  try {
    const accept = page.getByRole('button', { name: /accepter|tout accepter|accept/i }).first();
    if (await accept.count() && await accept.isVisible()) await accept.click({ timeout: 2_000 });
  } catch { /* ignore */ }

  // The recipe grid is client-rendered. Wait for either the first tagline
  // or the load-more button to appear before proceeding.
  await Promise.race([
    page.locator(TAGLINE_SELECTOR).first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => null),
    page.getByRole('button', { name: LOAD_MORE_RE }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  const clicks = await clickLoadMoreUntilGone(page);
  const taglines = await collectTaglines(page);
  const issues = taglines.filter((t) => /^Recipes$/i.test(t.text));

  console.log(`   clicks: ${clicks}, taglines: ${taglines.length}, "Recipes": ${issues.length}`);
  return { url, clicks, total: taglines.length, issues };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`Fetching sitemap: ${SITEMAP_URL}`);
  const allUrls = await collectSitemapUrls(SITEMAP_URL);
  const recettesPages = [...new Set(allUrls.filter((u) => RECETTES_RE.test(u)))].sort();

  console.log(`\nFound ${recettesPages.length} brand recettes page(s):`);
  recettesPages.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u}`));

  if (recettesPages.length === 0) {
    console.log('Nothing to audit.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'fr-CA',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const report = [];
  for (const url of recettesPages) {
    try {
      report.push(await auditPage(page, url));
    } catch (e) {
      console.warn(`   FAILED: ${e.message}`);
      report.push({ url, error: e.message, issues: [] });
    }
  }
  await browser.close();

  // ── Write reports ───────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = path.join(outDir, `recettes-audit-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');

  const totalIssues = report.reduce((n, r) => n + (r.issues?.length ?? 0), 0);

  const md = [];
  md.push(`# Recettes audit — "Recipes" tagline issues`);
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Total issues: **${totalIssues}** across ${report.length} page(s).`);
  md.push('');
  for (const r of report) {
    if (r.error) {
      md.push(`## ${r.url}`);
      md.push(`- ERROR: ${r.error}`);
      md.push('');
      continue;
    }
    if (!r.issues.length) continue;
    md.push(`## ${r.url}`);
    md.push(`Cards inspected: ${r.total} — issues: ${r.issues.length}`);
    md.push('');
    md.push(`| # | Title | Tagline | URL |`);
    md.push(`|---|-------|---------|-----|`);
    r.issues.forEach((i, idx) => {
      const title = (i.title ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
      const url = i.href ?? '';
      md.push(`| ${idx + 1} | ${title || '_(no title)_'} | ${i.text} | ${url} |`);
    });
    md.push('');
  }
  const mdPath = path.join(outDir, `recettes-audit-${stamp}.md`);
  fs.writeFileSync(mdPath, md.join('\n') + '\n');

  console.log(`\nDone. ${totalIssues} issue(s).`);
  console.log(`  JSON: ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  MD:   ${path.relative(process.cwd(), mdPath)}`);
}

run().catch((e) => {
  console.error('\nAudit failed:', e);
  process.exit(1);
});
