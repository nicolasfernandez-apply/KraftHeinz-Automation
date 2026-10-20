/**
 * DAM — Asset Load Audit
 *
 * Reads a list of singular URLs and/or sitemaps from dam-asset-load.config.json.
 * For every page (singular URL, plus every URL found in each sitemap) it:
 *   1. Navigates to the page (authenticating via IAP for the preview environment).
 *   2. Scrolls through it to trigger lazy loading.
 *   3. Waits for every image/video asset referenced in the DOM to either render
 *      or fail, and records one issue per asset that:
 *        - has an empty/malformed/unresolvable source ("invalid-url"), or
 *        - has a resolvable source that never renders ("asset-not-loading").
 *
 * Writes a single JSON report: the number of URLs checked, and the URLs that
 * had at least one broken asset, each with its list of {issueType, label}.
 *
 * Config file: dam-asset-load.config.json  (project root, or DAM_ASSET_LOAD_CONFIG)
 * Auth:        PREVIEW_USERNAME + PREVIEW_PASSWORD in .env (preview only)
 * Run:         npm run dam:asset-load
 */

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserContext, Page } from '@playwright/test';
import { requireAuthConfig, loginToPreview } from '../../utils/auth';
import { checkPageAssetLoading, AssetIssue } from '../../utils/dam/dam-asset-load-checker';
import { buildReport } from '../../utils/dam/dam-asset-load-report';

// ── Config ───────────────────────────────────────────────────────────────────

interface DamAssetLoadConfig {
  /** "preview" triggers IAP authentication; anything else skips auth. */
  environment: string;
  /** Individual pages to check, in addition to anything found via sitemaps. */
  singularUrls?: string[];
  /** Sitemap URLs to crawl; every <loc> found in each is checked. */
  sitemaps?: string[];
}

function loadConfig(): DamAssetLoadConfig {
  const configPath = process.env.DAM_ASSET_LOAD_CONFIG ?? path.resolve(process.cwd(), 'dam-asset-load.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `\ndam-asset-load.config.json not found: ${configPath}\n` +
      '  Create it at the project root:\n' +
      '  {\n' +
      '    "environment": "preview|production",\n' +
      '    "singularUrls": ["https://example.com/page"],\n' +
      '    "sitemaps": ["https://example.com/sitemap.xml"]\n' +
      '  }\n',
    );
  }

  let parsed: DamAssetLoadConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${configPath}: ${(e as Error).message}`);
  }

  if (!parsed.environment) {
    throw new Error('dam-asset-load.config.json must define "environment".');
  }

  const singularUrls = parsed.singularUrls ?? [];
  const sitemaps = parsed.sitemaps ?? [];
  if (singularUrls.length === 0 && sitemaps.length === 0) {
    throw new Error('dam-asset-load.config.json must define at least one of "singularUrls" or "sitemaps".');
  }

  return parsed;
}

function extractLocs(xml: string): string[] {
  return Array.from(new Set(
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()),
  ));
}

/** Scrolls to the bottom in steps so lazy-loaded assets attach before checking. */
async function triggerLazyLoading(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

const PAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;

const config = loadConfig();
const isPreview = config.environment.toLowerCase() === 'preview';

test('DAM asset load audit', async ({ browser }) => {
  test.setTimeout(0); // long-running crawl

  const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });

  if (isPreview) {
    const authCfg = requireAuthConfig();
    const seedUrl = config.singularUrls?.[0] ?? config.sitemaps?.[0];
    if (seedUrl) {
      const authPage = await context.newPage();
      await loginToPreview(authPage, authCfg, seedUrl);
      await authPage.close();
    }
  }

  // ── 1. Build the full list of page URLs ────────────────────────────────────
  const pageUrls = new Set<string>(config.singularUrls ?? []);

  if (config.sitemaps && config.sitemaps.length > 0) {
    // Sitemaps are fetched by navigating a real page rather than via the API
    // request context — kraftheinz.com's bot protection silently returns an
    // empty/challenge response to plain HTTP requests that lack a browser
    // fingerprint, which `context.request.get()` cannot pass.
    const seedPage = await context.newPage();
    const warmedOrigins = new Set<string>();
    for (const sitemapUrl of config.sitemaps) {
      console.log(`[sitemap] Fetching ${sitemapUrl}…`);
      try {
        // Cloudflare's bot check 503s a direct request for /sitemap.xml unless
        // the session has already visited the site's homepage in-browser.
        const origin = new URL(sitemapUrl).origin;
        if (!warmedOrigins.has(origin)) {
          warmedOrigins.add(origin);
          await seedPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS }).catch(() => {});
        }
        await seedPage.goto(sitemapUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        const xml = await seedPage.content();
        const locs = extractLocs(xml);
        console.log(`[sitemap] ${locs.length} URL(s) found in ${sitemapUrl}`);
        for (const loc of locs) pageUrls.add(loc);
      } catch (err) {
        console.error(`[sitemap] Failed to fetch ${sitemapUrl}: ${(err as Error).message}`);
      }
    }
    await seedPage.close();
  }

  const urls = [...pageUrls];
  console.log(`\n[config] Environment: ${config.environment}`);
  console.log(`[config] ${urls.length} URL(s) to check.\n`);

  // ── 2. Check every page for broken assets ──────────────────────────────────
  const results: { url: string; issues: AssetIssue[] }[] = [];
  let processed = 0;
  const queue = [...urls];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const page = await context.newPage();
    try {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        processed++;
        const prefix = `[${processed}/${urls.length}]`;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          await triggerLazyLoading(page);

          const { assetsChecked, issues } = await checkPageAssetLoading(page);
          results.push({ url, issues });

          const flag = issues.length > 0 ? `✗ ${issues.length} issue(s)` : '✓';
          console.log(`${prefix} ${flag} — ${assetsChecked} asset(s) — ${url}`);
        } catch (err) {
          const msg = (err as Error).message.split('\n')[0];
          console.log(`${prefix} ✗ ${url} — navigation failed: ${msg}`);
          results.push({
            url,
            issues: [{ label: url, issueType: 'asset-not-loading', url, source: 'page' }],
          });
        }
      }
    } finally {
      await page.close();
    }
  });

  await Promise.all(workers);
  await context.close();

  // ── 3. Write the JSON report ────────────────────────────────────────────────
  const report = buildReport(config.environment, results);

  const outDir = path.resolve(process.cwd(), 'reports', 'dam-asset-load');
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `dam-asset-load-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n' + '='.repeat(72));
  console.log('DAM ASSET LOAD AUDIT COMPLETE');
  console.log('='.repeat(72));
  console.log(`URLs checked        : ${report.urlsChecked}`);
  console.log(`URLs with issues    : ${report.urlsWithIssues.length}`);
  console.log(`Report saved to     : ${reportPath}`);
  console.log('='.repeat(72) + '\n');
});
