import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePage } from '../utils/analyzer';
import { diffAnalyses } from '../utils/differ';
import { generateReport } from '../utils/report-builder';
import { requireAuthConfig, loginToPreview } from '../utils/auth';

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';
const PRODUCTION_URL = process.env.PRODUCTION_URL ?? '';

test.describe('URL Comparison: Preview vs Production', () => {
  test('Generate comparison report', async ({ browser }, testInfo) => {
    if (!PREVIEW_URL || !PRODUCTION_URL) {
      throw new Error(
        'PREVIEW_URL and PRODUCTION_URL must be set.\n' +
        'Copy .env.example to .env and fill in your URLs, or export them as environment variables.',
      );
    }

    // Set up output directories
    const reportsDir = path.join(process.cwd(), 'reports');
    const screenshotsDir = path.join(reportsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const previewScreenshot = path.join(screenshotsDir, `preview-${timestamp}.png`);
    const productionScreenshot = path.join(screenshotsDir, `production-${timestamp}.png`);

    // Login is mandatory for the PRV environment (Google IAP).
    // Throws immediately with a clear message if credentials are missing.
    const auth = requireAuthConfig();

    // Open both pages in separate browser contexts
    const previewCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const productionCtx = await browser.newContext({ ignoreHTTPSErrors: true });

    const previewPage = await previewCtx.newPage();
    const productionPage = await productionCtx.newPage();

    try {
      // Authenticate against Google IAP before analyzing the PRV page
      await loginToPreview(previewPage, auth, PREVIEW_URL);

      // Analyze both URLs in parallel
      console.log(`\nAnalyzing Preview:    ${PREVIEW_URL}`);
      console.log(`Analyzing Production: ${PRODUCTION_URL}\n`);

      const [previewAnalysis, productionAnalysis] = await Promise.all([
        analyzePage(previewPage, PREVIEW_URL, previewScreenshot),
        analyzePage(productionPage, PRODUCTION_URL, productionScreenshot),
      ]);

      if (previewAnalysis.loadError) {
        console.warn(`⚠ Preview load error: ${previewAnalysis.loadError}`);
      }
      if (productionAnalysis.loadError) {
        console.warn(`⚠ Production load error: ${productionAnalysis.loadError}`);
      }

      // Compute diff
      const diff = diffAnalyses(previewAnalysis, productionAnalysis);

      // Generate HTML report
      const reportPath = path.join(reportsDir, `comparison-${timestamp}.html`);
      const html = generateReport(previewAnalysis, productionAnalysis, diff);
      fs.writeFileSync(reportPath, html, 'utf8');

      // Attach to Playwright test report
      await testInfo.attach('Comparison Report (HTML)', {
        path: reportPath,
        contentType: 'text/html',
      });
      if (fs.existsSync(previewScreenshot)) {
        await testInfo.attach('Preview Screenshot', { path: previewScreenshot, contentType: 'image/png' });
      }
      if (fs.existsSync(productionScreenshot)) {
        await testInfo.attach('Production Screenshot', { path: productionScreenshot, contentType: 'image/png' });
      }

      // Print summary to console
      console.log('='.repeat(60));
      console.log('COMPARISON SUMMARY');
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
});
