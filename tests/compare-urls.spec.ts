import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePage } from '../utils/analyzer';
import { diffAnalyses } from '../utils/differ';
import { generateReport } from '../utils/report-builder';
import { requireAuthConfig, loginToPreview } from '../utils/auth';

// ── URL pair config ───────────────────────────────────────────────────────────

interface UrlPair {
  /** Human-readable label used in the test name and report filename */
  name: string;
  previewUrl: string;
  productionUrl: string;
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
      // Credentials are mandatory — throws immediately with a clear message if missing
      const auth = requireAuthConfig();

      // Set up output directories
      const reportsDir = path.join(process.cwd(), 'reports');
      const screenshotsDir = path.join(reportsDir, 'screenshots');
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = slugify(pair.name);
      const previewScreenshot = path.join(screenshotsDir, `${slug}-preview-${timestamp}.png`);
      const productionScreenshot = path.join(screenshotsDir, `${slug}-production-${timestamp}.png`);

      // Open both pages in separate browser contexts
      const previewCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const productionCtx = await browser.newContext({ ignoreHTTPSErrors: true });

      const previewPage = await previewCtx.newPage();
      const productionPage = await productionCtx.newPage();

      try {
        // Authenticate against Google IAP before analyzing the PRV page
        await loginToPreview(previewPage, auth, pair.previewUrl);

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
        const html = generateReport(previewAnalysis, productionAnalysis, diff);
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
      } finally {
        await previewCtx.close();
        await productionCtx.close();
      }
    });
  }
});
