import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePage, DesignTokens } from '../../utils/analyzer';
import { diffAnalyses } from '../../utils/differ';
import { generateReport } from '../../utils/report-builder';
import { requireAuthConfig, loginToPreview } from '../../utils/auth';

// ── Design tokens ─────────────────────────────────────────────────────────────
// Loaded once at module initialisation.  refresh-tokens.mjs may have updated
// the file before this spec runs; if the file is absent we proceed without
// token checking rather than failing the whole suite.

const designTokensPath = path.resolve(__dirname, 'design-tokens.json');
const designTokens: DesignTokens | null = fs.existsSync(designTokensPath)
  ? (JSON.parse(fs.readFileSync(designTokensPath, 'utf8')) as DesignTokens)
  : null;

if (designTokens) {
  console.log('[compare] Design tokens loaded — token compliance will be checked for each page.');
} else {
  console.warn('[compare] design-tokens.json not found — skipping token compliance check.');
}

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

      // Restore the IAP session written by globalSetup — loginToPreview will
      // detect the valid session and skip the Firebase email-lookup entirely.
      const hostname = new URL(pair.previewUrl).hostname;
      const stateFile = path.join(process.cwd(), '.auth', `${hostname}.json`);
      const previewCtx     = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(fs.existsSync(stateFile) ? { storageState: stateFile } : {}),
      });
      const productionCtx  = await browser.newContext({ ignoreHTTPSErrors: true });
      const previewPage    = await previewCtx.newPage();
      const productionPage = await productionCtx.newPage();

      try {
        // loginToPreview returns immediately when the session is already valid;
        // it only performs a full login if the IAP session has expired.
        await loginToPreview(previewPage, auth, pair.previewUrl);

        console.log(`\nAnalyzing Preview:    ${pair.previewUrl}`);
        console.log(`Analyzing Production: ${pair.productionUrl}\n`);

        const [previewAnalysis, productionAnalysis] = await Promise.all([
          analyzePage(previewPage, pair.previewUrl, previewScreenshot, designTokens),
          analyzePage(productionPage, pair.productionUrl, productionScreenshot, designTokens),
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

        // ── Test failure checks ───────────────────────────────────────────────
        const testFailures: string[] = [];

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
