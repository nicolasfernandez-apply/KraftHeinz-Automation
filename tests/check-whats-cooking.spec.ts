import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginToPreview, requireAuthConfig } from '../utils/auth';

const SITEMAP_URL = 'https://brands.prv.kraftheinz.com/sitemap.xml';

// Match either the legacy whatscooking.com domain (any subdomain) or any
// /whats-cooking* pathname on kraftheinz.com — covers absolute and relative
// hrefs alike. Case-insensitive so we don't miss "/Whats-Cooking" etc.
const BAD_LINK_RE = /(whatscooking\.com|\/whats[-_]?cooking)/i;

const PAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY     = 4;

test('Find pages still linking to What\'s Cooking', async ({ browser }) => {
  test.setTimeout(0); // long-running crawl — disable Playwright's per-test cap

  const auth = requireAuthConfig();
  const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
  const seedPage = await ctx.newPage();

  // ── 1. Authenticate once for the preview domain ─────────────────────────
  await loginToPreview(seedPage, auth, SITEMAP_URL);

  // ── 2. Fetch + parse the sitemap ────────────────────────────────────────
  await seedPage.goto(SITEMAP_URL, { waitUntil: 'domcontentloaded' });
  const sitemapXml = await seedPage.content();

  const urls = Array.from(new Set(
    [...sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()),
  ));
  console.log(`[crawl] Sitemap returned ${urls.length} unique URLs.\n`);

  await seedPage.close();

  // ── 3. Visit each URL and collect "What's Cooking" hrefs ────────────────
  type Offender = { url: string; links: string[]; loadError?: string };
  const offenders: Offender[] = [];
  let processed = 0;

  // Simple worker-pool concurrency
  const queue = [...urls];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const page = await ctx.newPage();
    try {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        processed++;
        const prefix = `[${processed}/${urls.length}]`;
        try {
          await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
          // Allow client-side hydration to settle a moment so SPA-rendered
          // hrefs end up in the DOM. Short cap — we're not benchmarking.
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
          const hrefs = await page.$$eval('a[href]', (anchors) =>
            (anchors as HTMLAnchorElement[]).map((a) => a.getAttribute('href') || ''),
          );
          // Resolve relative hrefs against the page URL for cleaner reporting.
          const resolved = hrefs
            .filter(Boolean)
            .map((h) => { try { return new URL(h, url).toString(); } catch { return h; } });
          const matches = Array.from(new Set(resolved.filter((h) => BAD_LINK_RE.test(h))));
          if (matches.length > 0) {
            offenders.push({ url, links: matches });
            console.log(`${prefix} ⚠ ${url} — ${matches.length} match${matches.length !== 1 ? 'es' : ''}`);
          } else {
            console.log(`${prefix} ✓ ${url}`);
          }
        } catch (err) {
          const msg = (err as Error).message.split('\n')[0];
          console.log(`${prefix} ✗ ${url} — ${msg}`);
          offenders.push({ url, links: [], loadError: msg });
        }
      }
    } finally {
      await page.close();
    }
  });

  await Promise.all(workers);

  // ── 4. Summarise ────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(72));
  console.log(`PAGES WITH "WHAT'S COOKING" LINKS: ${offenders.filter((o) => o.links.length > 0).length}`);
  console.log('='.repeat(72));
  for (const o of offenders) {
    if (o.links.length === 0) continue;
    console.log(`\n${o.url}`);
    for (const link of o.links) console.log(`  → ${link}`);
  }

  const errors = offenders.filter((o) => o.loadError);
  if (errors.length > 0) {
    console.log('\n' + '-'.repeat(72));
    console.log(`PAGES THAT FAILED TO LOAD: ${errors.length}`);
    console.log('-'.repeat(72));
    for (const o of errors) console.log(`  ${o.url} — ${o.loadError}`);
  }

  // ── 5. Persist a JSON copy so it's easy to grep later ───────────────────
  const outDir = path.join(process.cwd(), 'reports', 'whats-cooking');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    sitemap:        SITEMAP_URL,
    totalUrls:      urls.length,
    offenderCount:  offenders.filter((o) => o.links.length > 0).length,
    failureCount:   errors.length,
    offenders,
  }, null, 2), 'utf8');
  console.log(`\nFull report saved to: ${outPath}\n`);

  await ctx.close();
});
