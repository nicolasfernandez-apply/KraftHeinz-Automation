/**
 * DAM — URL Validation
 *
 * Reads page entries from dam-urls.config.json. For each entry it:
 *   1. Navigates to the URL (authenticating via IAP for preview environments).
 *   2. Collects every image and video source referenced by the rendered page.
 *   3. Checks whether each asset URL contains the configured target URL
 *      (case-insensitive substring — partial hits count as a pass).
 *   4. Attaches a full-page screenshot plus an HTML/CSV/JSON report listing the
 *      assets that passed and the assets that failed.
 *
 * The test fails when at least one asset does not point at the target.
 *
 * Config file: dam-urls.config.json  (project root, or DAM_URLS_CONFIG)
 * Auth:        PREVIEW_USERNAME + PREVIEW_PASSWORD in .env (preview only)
 * Run:         npm run dam:urls   (or `npm run dam` for every DAM test)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuthConfig, loginToPreview } from '../../utils/auth';
import { runPreAction } from '../../utils/pre-action';
import { classifyAssets, collectPageAssets, DamValidationResult } from '../../utils/dam/dam-url-validator';
import { generateDamUrlCsv, generateDamUrlReport } from '../../utils/dam/dam-url-report';

// ── Config types & loader ─────────────────────────────────────────────────────

interface DamPageEntry {
  /** Human-readable label shown in the Playwright report */
  name: string;
  url: string;
  /** "preview" triggers IAP authentication; anything else skips auth */
  environment: string;
  /** Overrides the top-level targetUrl for this page only */
  targetUrl?: string | string[];
  /** Optional pre-action name from pre-actions.config.json (e.g. age gate) */
  preAction?: string;
  /** Extra URL fragments to skip for this page, on top of the top-level list */
  ignore?: string | string[];
}

interface DamUrlsConfig {
  /** Target URL(s) every asset is expected to be served from. */
  targetUrl: string | string[];
  /**
   * URL fragments whose assets are excluded from grading — third-party chrome
   * such as cookie-banner icons that will never live in the DAM.
   */
  ignore?: string | string[];
  pages: DamPageEntry[];
}

function toList(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : (value ?? '').split(',');
  return items.map((s) => s.trim()).filter(Boolean);
}

function loadConfig(): DamUrlsConfig {
  const configPath = process.env.DAM_URLS_CONFIG ?? path.resolve(process.cwd(), 'dam-urls.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `\ndam-urls.config.json not found: ${configPath}\n` +
      '  Create it at the project root:\n' +
      '  {\n' +
      '    "targetUrl": "scene7.com",\n' +
      '    "pages": [\n' +
      '      { "name": "...", "url": "...", "environment": "preview|production" }\n' +
      '    ]\n' +
      '  }\n',
    );
  }

  let parsed: DamUrlsConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${configPath}: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error('dam-urls.config.json must have a non-empty "pages" array.');
  }
  if (toList(parsed.targetUrl).length === 0 && parsed.pages.some((p) => toList(p.targetUrl).length === 0)) {
    throw new Error('dam-urls.config.json must define "targetUrl" at the top level or on every page.');
  }

  return parsed;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Scrolls to the bottom in steps so lazy-loaded images and videos are attached
 * to the DOM before assets are collected, then returns to the top for the
 * screenshot.
 */
async function triggerLazyLoading(page: import('@playwright/test').Page): Promise<void> {
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

// ── Test suite ────────────────────────────────────────────────────────────────

const config = loadConfig();
const defaultTargets = toList(config.targetUrl);
const defaultIgnore = toList(config.ignore);

for (const entry of config.pages) {
  const targetUrls = toList(entry.targetUrl).length > 0 ? toList(entry.targetUrl) : defaultTargets;
  const ignore = [...defaultIgnore, ...toList(entry.ignore)];

  test(`DAM URL validation — ${entry.name}`, async ({ browser }, testInfo) => {
    const isPreview = entry.environment.toLowerCase() === 'preview';
    const context = await browser.newContext();

    try {
      if (isPreview) {
        const authCfg = requireAuthConfig();
        const authPage = await context.newPage();
        await loginToPreview(authPage, authCfg, entry.url);
        await authPage.close();
      }

      const page = await context.newPage();

      console.log(`\n[DAM] Navigating to: ${entry.url}`);
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      if (entry.preAction) {
        await runPreAction(page, entry.preAction);
      }

      await triggerLazyLoading(page);

      const assets = await collectPageAssets(page);
      const { passed, failed, ignored } = classifyAssets(assets, targetUrls, ignore);
      console.log(
        `[DAM] ${assets.length} reference(s) → ${passed.length + failed.length + ignored.length} ` +
        `unique asset(s) — ${passed.length} passed, ` +
        `${failed.length} failed, ${ignored.length} ignored`,
      );

      const outDir = path.resolve(process.cwd(), 'reports', 'dam-url-validation');
      fs.mkdirSync(outDir, { recursive: true });
      const slug = slugify(entry.name);

      const screenshotPath = path.join(outDir, `${slug}.png`);
      const screenshot = await page.screenshot({ fullPage: true, path: screenshotPath });

      const result: DamValidationResult = {
        name: entry.name,
        url: entry.url,
        environment: entry.environment,
        targetUrls,
        generatedAt: new Date().toISOString(),
        passed,
        failed,
        ignored,
        screenshotBase64: screenshot.toString('base64'),
      };

      const html = generateDamUrlReport(result);
      const csv = generateDamUrlCsv(result);

      fs.writeFileSync(path.join(outDir, `${slug}.html`), html, 'utf8');
      fs.writeFileSync(path.join(outDir, `${slug}.csv`), csv, 'utf8');
      console.log(`[DAM] Report saved: ${path.join(outDir, `${slug}.html`)}`);

      await testInfo.attach('Page Screenshot', { body: screenshot, contentType: 'image/png' });
      await testInfo.attach(`dam-url-report-${slug}.html`, {
        contentType: 'text/html',
        body: Buffer.from(html, 'utf8'),
      });
      await testInfo.attach(`dam-url-assets-${slug}.csv`, {
        contentType: 'text/csv',
        body: Buffer.from(csv, 'utf8'),
      });
      await testInfo.attach(`dam-url-assets-${slug}.json`, {
        contentType: 'application/json',
        // The screenshot is already attached separately — keep the JSON readable.
        body: Buffer.from(JSON.stringify({ ...result, screenshotBase64: undefined }, null, 2), 'utf8'),
      });

      expect(passed.length + failed.length, `No image or video assets were found on ${entry.url}`).toBeGreaterThan(0);

      const failureList = failed
        .map((a) => `  • [${a.kind}] ${a.url}  (${a.occurrences}× — ${a.sources.join(', ')})`)
        .join('\n');
      expect(
        failed.length,
        `${failed.length} asset(s) are not served from ${targetUrls.join(' / ')}:\n${failureList}`,
      ).toBe(0);
    } finally {
      await context.close();
    }
  });
}
