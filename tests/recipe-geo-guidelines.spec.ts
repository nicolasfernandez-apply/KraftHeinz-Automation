import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginToPreview, requireAuthConfig } from '../utils/auth';
import { runPreAction } from '../utils/pre-action';
import {
  runHardChecks,
  runSoftChecks,
  generateRecipeGeoReport,
  RecipeGeoReport,
} from '../utils/recipe-geo-validator';

// ── Config ───────────────────────────────────────────────────────────────────

interface RecipeGeoConfig {
  url?: string;
  urls?: string[];
  environment: 'preview' | 'production';
  /**
   * Optional name of a pre-action defined in pre-actions.config.json.
   * When set, the action is executed after login but before hard/soft checks
   * (e.g. dismiss an age gate, select a country).
   */
  preAction?: string;
}

const configPath = process.env.RECIPE_GEO_CONFIG ?? path.resolve(process.cwd(), 'recipe-geo.config.json');
if (!fs.existsSync(configPath)) {
  throw new Error(
    `\n  Recipe GEO config not found: ${configPath}\n` +
    '  Create recipe-geo.config.json in the repo root, or point RECIPE_GEO_CONFIG at a different file.\n',
  );
}

const config: RecipeGeoConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.environment) {
  throw new Error('Config must include `environment` ("preview" | "production").');
}

const urls: string[] = config.urls?.length ? config.urls : config.url ? [config.url] : [];
if (urls.length === 0) {
  throw new Error('Config must include `url` (string) or `urls` (string[]).');
}

// ── Reports directory ────────────────────────────────────────────────────────

const reportsDir = path.join(process.cwd(), 'reports', 'recipe-geo');
fs.rmSync(reportsDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ── Tests ────────────────────────────────────────────────────────────────────

for (const url of urls) {
  test.describe(`Recipe GEO: ${url}`, () => {
    test.describe.configure({ mode: 'serial' });

    test('Hard + Soft requirements', async ({ browser }, testInfo) => {
      testInfo.setTimeout(300_000);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = slugify(new URL(url).pathname || 'home') || 'page';
      const reportPath = path.join(reportsDir, `${slug}-${timestamp}.html`);

      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();

      try {
        if (config.environment === 'preview') {
          const auth = requireAuthConfig();
          await loginToPreview(page, auth, url);
        }

        console.log(`[RecipeGEO] Navigating to ${url}…`);
        // Navigate first so the pre-action can inspect the live page.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

        if (config.preAction) {
          console.log(`[RecipeGEO] Running pre-action "${config.preAction}"…`);
          await runPreAction(page, config.preAction);
        }

        // Screenshot
        const screenshotBuf = await page.screenshot({ fullPage: true }).catch(() => null);

        // Hard checks
        console.log('[RecipeGEO] Running hard requirement checks…');
        const hardChecks = await runHardChecks(page);

        // Soft checks (Claude CLI)
        console.log('[RecipeGEO] Running soft requirement checks (Claude)…');
        const softChecks = await runSoftChecks(page);

        const report: RecipeGeoReport = {
          url,
          environment: config.environment,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          hardChecks,
          softChecks,
          screenshotBase64: screenshotBuf?.toString('base64'),
        };

        // Generate and save HTML report
        const html = generateRecipeGeoReport(report);
        fs.writeFileSync(reportPath, html, 'utf8');

        // Attach to Playwright report
        await testInfo.attach('Recipe GEO Report (HTML)', {
          path: reportPath,
          contentType: 'text/html',
        });
        if (screenshotBuf) {
          await testInfo.attach('Page Screenshot', {
            body: screenshotBuf,
            contentType: 'image/png',
          });
        }

        // Console summary
        const hardPass = hardChecks.filter((c) => c.passed).length;
        const softPass = softChecks.filter((c) => c.score === 'pass').length;
        const softWarn = softChecks.filter((c) => c.score === 'warn').length;
        const softFail = softChecks.filter((c) => c.score === 'fail').length;

        console.log('\n' + '='.repeat(60));
        console.log(`RECIPE GEO REPORT — ${config.environment}: ${url}`);
        console.log('='.repeat(60));
        console.log(`Hard requirements:  ${hardPass}/${hardChecks.length} passed`);
        console.log(`Soft requirements:  ${softPass} pass / ${softWarn} warn / ${softFail} fail`);
        console.log('='.repeat(60));
        console.log(`Report saved to: ${reportPath}\n`);

        // Fail the test if any hard requirement failed
        const failedHard = hardChecks.filter((c) => !c.passed);
        expect(
          failedHard.length,
          `${failedHard.length} hard requirement(s) failed:\n${failedHard.map((c) => `  ❌ ${c.label}: ${c.detail}`).join('\n')}`,
        ).toBe(0);
      } finally {
        await ctx.close();
      }
    });
  });
}
