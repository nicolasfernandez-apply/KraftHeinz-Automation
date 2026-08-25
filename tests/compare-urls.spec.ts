import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePage } from '../utils/analyzer';
import { diffAnalyses } from '../utils/differ';
import { generateReport } from '../utils/report-builder';
import { requireAuthConfig, loginToPreview } from '../utils/auth';
import { runPreAction } from '../utils/pre-action';

// ── URL pair config ───────────────────────────────────────────────────────────

interface UrlPair {
  /** Human-readable label used in the test name and report filename */
  name: string;
  previewUrl: string;
  productionUrl: string;
  /** Override the "Preview" column label in the report (e.g. "Preview A") */
  labelA?: string;
  /** Override the "Production" column label in the report (e.g. "Preview B") */
  labelB?: string;
  /**
   * Optional name of a pre-action defined in pre-actions.config.json.
   * Executed on both pages after login but before analysis
   * (e.g. dismiss an age gate, select a country).
   */
  preAction?: string;
}

/**
 * Loads URL pairs to compare.
 *
 * Priority:
 *   1. JSON file at the path in URLS_CONFIG env var (default: urls.config.json)
 *   2. PREVIEW_URL + PRODUCTION_URL env vars (single-pair fallback)
 */
function loadUrlPairs(): UrlPair[] {
  const configPath = path.resolve(
    process.cwd(),
    process.env.URLS_CONFIG?.trim() ?? 'urls.config.json',
  );

  if (fs.existsSync(configPath)) {
    let parsed: { comparisons?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${configPath}: ${(e as Error).message}`);
    }

    if (!Array.isArray(parsed.comparisons) || parsed.comparisons.length === 0) {
      throw new Error(
        `${configPath} must contain a non-empty "comparisons" array.\n` +
        `See urls.config.json for the expected format.`,
      );
    }

    return parsed.comparisons as UrlPair[];
  }

  // Fallback: single pair from env vars (keeps backward compatibility)
  const previewUrl = process.env.PREVIEW_URL?.trim();
  const productionUrl = process.env.PRODUCTION_URL?.trim();

  if (previewUrl && productionUrl) {
    console.warn(
      '\nNo urls.config.json found — falling back to PREVIEW_URL / PRODUCTION_URL env vars.\n',
    );
    return [{ name: 'URL Comparison', previewUrl, productionUrl }];
  }

  throw new Error(
    '\nNo URL configuration found.\n' +
    `  Option 1 (recommended): add pairs to urls.config.json\n` +
    `  Option 2 (single pair): set PREVIEW_URL and PRODUCTION_URL env vars\n`,
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Load pairs once at module level — Playwright evaluates this before any test runs
const urlPairs = loadUrlPairs();

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('URL Comparison: Preview vs Production', () => {
  for (const pair of urlPairs) {
    test(pair.name, async ({ browser }, testInfo) => {
      const auth = requireAuthConfig();

      // Set up output directories
      const reportsDir = path.join(process.cwd(), 'reports');
      const screenshotsDir = path.join(reportsDir, 'screenshots');
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = slugify(pair.name);
      const previewScreenshot = path.join(screenshotsDir, `${slug}-preview-${timestamp}.png`);
      const productionScreenshot = path.join(screenshotsDir, `${slug}-production-${timestamp}.png`);

      // Restore the IAP session written by globalSetup — loginToPreview will
      // detect the valid session and skip the Firebase email-lookup entirely.
      const hostnameA = new URL(pair.previewUrl).hostname;
      const stateFileA = path.join(process.cwd(), '.auth', `${hostnameA}.json`);
      const previewCtx = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(fs.existsSync(stateFileA) ? { storageState: stateFileA } : {}),
      });

      // If the second URL is also a preview host, load its IAP session too.
      const hostnameB = new URL(pair.productionUrl).hostname;
      const stateFileB = path.join(process.cwd(), '.auth', `${hostnameB}.json`);
      const isSecondUrlPreview = fs.existsSync(stateFileB);
      const productionCtx = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(isSecondUrlPreview ? { storageState: stateFileB } : {}),
      });

      const previewPage = await previewCtx.newPage();
      const productionPage = await productionCtx.newPage();

      try {
        // loginToPreview returns immediately when the session is already valid;
        // it only performs a full login if the IAP session has expired.
        await loginToPreview(previewPage, auth, pair.previewUrl);
        if (isSecondUrlPreview) {
          await loginToPreview(productionPage, auth, pair.productionUrl);
        }

        // Run pre-action on both pages if configured (after login, before analysis).
        if (pair.preAction) {
          console.log(`[compare] Running pre-action "${pair.preAction}" on both pages…`);
          await Promise.all([
            (async () => {
              await previewPage.goto(pair.previewUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
              await previewPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
              await runPreAction(previewPage, pair.preAction!);
            })(),
            (async () => {
              await productionPage.goto(pair.productionUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
              await productionPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
              await runPreAction(productionPage, pair.preAction!);
            })(),
          ]);
        }

        // Analyze both URLs (sequentially — login must finish first, then parallel is fine)
        console.log(`\nAnalyzing Preview:    ${pair.previewUrl}`);
        console.log(`Analyzing Production: ${pair.productionUrl}\n`);

        const [previewAnalysis, productionAnalysis] = await Promise.all([
          analyzePage(previewPage, pair.previewUrl, previewScreenshot),
          analyzePage(productionPage, pair.productionUrl, productionScreenshot),
        ]);

        if (previewAnalysis.loadError) {
          console.warn(`⚠ Preview load error: ${previewAnalysis.loadError}`);
        }
        if (productionAnalysis.loadError) {
          console.warn(`⚠ Production load error: ${productionAnalysis.loadError}`);
        }

        // Compute diff
        const diff = diffAnalyses(previewAnalysis, productionAnalysis);

        // Generate HTML report — one file per URL pair
        const reportPath = path.join(reportsDir, `${slug}-${timestamp}.html`);
        const html = generateReport(previewAnalysis, productionAnalysis, diff, {
          labelA: pair.labelA,
          labelB: pair.labelB,
        });
        fs.writeFileSync(reportPath, html, 'utf8');

        // Attach to Playwright test report for easy access in CI
        await testInfo.attach('Comparison Report (HTML)', {
          path: reportPath,
          contentType: 'text/html',
        });
        if (fs.existsSync(previewScreenshot)) {
          await testInfo.attach('Preview Screenshot', {
            path: previewScreenshot,
            contentType: 'image/png',
          });
        }
        if (fs.existsSync(productionScreenshot)) {
          await testInfo.attach('Production Screenshot', {
            path: productionScreenshot,
            contentType: 'image/png',
          });
        }

        // Console summary
        console.log('='.repeat(60));
        console.log(`COMPARISON SUMMARY — ${pair.name}`);
        console.log('='.repeat(60));
        console.log(`Total differences:    ${diff.totalDifferences}`);
        console.log(`Critical differences: ${diff.criticalDifferences}`);
        console.log(`Preview issues:       ${diff.consoleErrors.preview.length}`);
        console.log(`Production issues:    ${diff.consoleErrors.production.length}`);
        console.log('='.repeat(60));
        console.log(`\nReport saved to: ${reportPath}\n`);

        if (diff.criticalDifferences > 0) {
          console.log('⚠ CRITICAL DIFFERENCES FOUND:');
          if (diff.statusCode.isDifferent) {
            console.log(`  • HTTP Status: ${diff.statusCode.preview} (preview) vs ${diff.statusCode.production} (production)`);
          }
          if (diff.metadata.title.isDifferent) {
            console.log(`  • Title: "${diff.metadata.title.preview}" vs "${diff.metadata.title.production}"`);
          }
          if (diff.metadata.description.isDifferent) {
            console.log(`  • Meta description differs`);
          }
          if (diff.metadata.robots.isDifferent) {
            console.log(`  • Robots: "${diff.metadata.robots.preview}" vs "${diff.metadata.robots.production}"`);
          }
          console.log('');
        }

        // ── Test failure checks ───────────────────────────────────────────────
        // Marks the test as failed when a page is absent from one environment,
        // or when the Images / Content Comparison sections show differences.
        const testFailures: string[] = [];

        // "Only in" — page loads on one side but not the other
        const previewFailed    = Boolean(previewAnalysis.loadError) || previewAnalysis.statusCode >= 400;
        const productionFailed = Boolean(productionAnalysis.loadError) || productionAnalysis.statusCode >= 400;

        if (!previewFailed && productionFailed) {
          testInfo.annotations.push({ type: 'tag', description: 'only-in-preview' });
          testFailures.push(
            `Only in Preview — Production returned ${productionAnalysis.statusCode || 'error'}` +
            (productionAnalysis.loadError ? `: ${productionAnalysis.loadError}` : ''),
          );
        }
        if (previewFailed && !productionFailed) {
          testInfo.annotations.push({ type: 'tag', description: 'only-in-production' });
          testFailures.push(
            `Only in Production — Preview returned ${previewAnalysis.statusCode || 'error'}` +
            (previewAnalysis.loadError ? `: ${previewAnalysis.loadError}` : ''),
          );
        }

        // Images section + Content Comparison section
        const contentDiffDetails: string[] = [];
        if (diff.imagesCount.isDifferent)
          contentDiffDetails.push(`image count (preview: ${diff.imagesCount.preview}, production: ${diff.imagesCount.production})`);
        if (diff.imagesWithoutAlt.isDifferent)
          contentDiffDetails.push(`images missing alt (preview: ${diff.imagesWithoutAlt.preview}, production: ${diff.imagesWithoutAlt.production})`);
        if (diff.content.images.isDifferent)
          contentDiffDetails.push(`image paths (${diff.content.images.onlyInPreview.length} only in preview, ${diff.content.images.onlyInProduction.length} only in production)`);
        if (diff.content.text.isDifferent)
          contentDiffDetails.push(`text blocks (${diff.content.text.onlyInPreview.length} only in preview, ${diff.content.text.onlyInProduction.length} only in production)`);
        if (diff.content.links.isDifferent)
          contentDiffDetails.push(`links (${diff.content.links.onlyInPreview.length} only in preview, ${diff.content.links.onlyInProduction.length} only in production)`);
        if (diff.content.videos.isDifferent)
          contentDiffDetails.push(`videos (${diff.content.videos.onlyInPreview.length} only in preview, ${diff.content.videos.onlyInProduction.length} only in production)`);

        if (contentDiffDetails.length > 0) {
          testInfo.annotations.push({ type: 'tag', description: 'difference-in-content' });
          testFailures.push(
            `Difference in content:\n${contentDiffDetails.map((d) => `  • ${d}`).join('\n')}`,
          );
        }

        if (testFailures.length > 0) {
          throw new Error(testFailures.join('\n'));
        }
      } finally {
        await previewCtx.close();
        await productionCtx.close();
      }
    });
  }
});
