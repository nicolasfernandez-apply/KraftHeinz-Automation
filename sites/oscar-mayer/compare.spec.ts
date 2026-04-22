import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePage } from '../../utils/analyzer';
import { diffAnalyses } from '../../utils/differ';
import { generateReport } from '../../utils/report-builder';
import { requireAuthConfig, loginToPreview } from '../../utils/auth';

// ── Load discovered pages ─────────────────────────────────────────────────────

interface UrlPair {
  name: string;
  previewUrl: string;
  productionUrl: string;
}

const pagesPath = path.resolve(process.cwd(), 'sites', 'oscar-mayer', 'pages.json');

if (!fs.existsSync(pagesPath)) {
  throw new Error(
    '\nNo pages.json found for Oscar Mayer.\n' +
    'Run the crawler first:  npm run crawl:oscar-mayer\n',
  );
}

const { comparisons: urlPairs }: { comparisons: UrlPair[] } = JSON.parse(
  fs.readFileSync(pagesPath, 'utf8'),
);

if (!Array.isArray(urlPairs) || urlPairs.length === 0) {
  throw new Error('pages.json is empty or malformed. Re-run: npm run crawl:oscar-mayer');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Oscar Mayer — Preview vs Production', () => {
  for (const pair of urlPairs) {
    test(pair.name, async ({ browser }, testInfo) => {
      const auth = requireAuthConfig();

      const reportsDir     = path.join(process.cwd(), 'sites', 'oscar-mayer', 'reports');
      const screenshotsDir = path.join(reportsDir, 'screenshots');
      fs.mkdirSync(screenshotsDir, { recursive: true });

      const timestamp          = new Date().toISOString().replace(/[:.]/g, '-');
      const slug               = slugify(pair.name);
      const previewScreenshot  = path.join(screenshotsDir, `${slug}-preview-${timestamp}.png`);
      const productionScreenshot = path.join(screenshotsDir, `${slug}-production-${timestamp}.png`);

      const previewCtx     = await browser.newContext({ ignoreHTTPSErrors: true });
      const productionCtx  = await browser.newContext({ ignoreHTTPSErrors: true });
      const previewPage    = await previewCtx.newPage();
      const productionPage = await productionCtx.newPage();

      try {
        // Authenticate to Google IAP before analyzing the preview page
        await loginToPreview(previewPage, auth, pair.previewUrl);

        console.log(`\nAnalyzing Preview:    ${pair.previewUrl}`);
        console.log(`Analyzing Production: ${pair.productionUrl}\n`);

        const [previewAnalysis, productionAnalysis] = await Promise.all([
          analyzePage(previewPage, pair.previewUrl, previewScreenshot),
          analyzePage(productionPage, pair.productionUrl, productionScreenshot),
        ]);

        if (previewAnalysis.loadError)
          console.warn(`⚠ Preview load error: ${previewAnalysis.loadError}`);
        if (productionAnalysis.loadError)
          console.warn(`⚠ Production load error: ${productionAnalysis.loadError}`);

        const diff       = diffAnalyses(previewAnalysis, productionAnalysis);
        const reportPath = path.join(reportsDir, `${slug}-${timestamp}.html`);
        const html       = generateReport(previewAnalysis, productionAnalysis, diff);
        fs.writeFileSync(reportPath, html, 'utf8');

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
            console.log(
              `  • HTTP Status: ${diff.statusCode.preview} (preview) vs ${diff.statusCode.production} (production)`,
            );
          }
          if (diff.metadata.title.isDifferent) {
            console.log(
              `  • Title: "${diff.metadata.title.preview}" vs "${diff.metadata.title.production}"`,
            );
          }
          if (diff.metadata.description.isDifferent) {
            console.log('  • Meta description differs');
          }
          if (diff.metadata.robots.isDifferent) {
            console.log(
              `  • Robots: "${diff.metadata.robots.preview}" vs "${diff.metadata.robots.production}"`,
            );
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
