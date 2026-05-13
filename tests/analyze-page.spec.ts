import { test } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { analyzePage }            from '../utils/analyzer';
import { fetchFigmaTokens }       from '../utils/figma-tokens';
import { loginToPreview, requireAuthConfig } from '../utils/auth';
import { generateSinglePageReport } from '../utils/single-page-report';

interface AnalyzeConfig {
  url:           string;
  environment:   'preview' | 'production';
  figmaFileKey?: string;
  /** Optional. Defaults to reports/analyze/<slug>-<timestamp>.html */
  outputPath?:   string;
}

const configPath = process.env.ANALYZE_CONFIG;
if (!configPath) {
  throw new Error(
    '\n  ANALYZE_CONFIG env var not set.\n' +
    '  Point it at a JSON file describing the page to analyse, e.g.\n' +
    '    ANALYZE_CONFIG=./analyze.config.json npm run analyze\n',
  );
}
if (!fs.existsSync(configPath)) {
  throw new Error(`\n  ANALYZE_CONFIG points to a file that does not exist: ${configPath}\n`);
}

const config: AnalyzeConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.url || !config.environment) {
  throw new Error('Config must include `url` and `environment` ("preview" | "production").');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

test(`Analyze ${config.environment.toUpperCase()} — ${config.url}`, async ({ browser }, testInfo) => {
  // ── Resolve output paths ──────────────────────────────────────────────
  const reportsDir = path.join(process.cwd(), 'reports', 'analyze');
  fs.mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug      = slugify(new URL(config.url).pathname || 'home') || 'page';
  const outputPath     = config.outputPath || path.join(reportsDir, `${slug}-${timestamp}.html`);
  const screenshotPath = path.join(reportsDir, `${slug}-${timestamp}.png`);

  // ── Design tokens (optional) ──────────────────────────────────────────
  let designTokens = null;
  if (config.figmaFileKey) {
    const figmaToken = process.env.FIGMA_TOKEN?.trim();
    if (!figmaToken) {
      console.warn('[analyze] FIGMA_TOKEN env var not set — skipping design token check.');
    } else {
      try {
        console.log(`[analyze] Fetching Figma tokens for file ${config.figmaFileKey}…`);
        designTokens = await fetchFigmaTokens(config.figmaFileKey, figmaToken);
        const colorCount = countLeafs(designTokens.colors);
        const typoCount  = countLeafs(designTokens.typography);
        console.log(`[analyze] Loaded ${colorCount} color tokens + ${typoCount} typography tokens.`);
      } catch (err) {
        console.warn(`[analyze] Figma fetch failed (${(err as Error).message}) — proceeding without tokens.`);
      }
    }
  } else {
    console.log('[analyze] No figmaFileKey in config — design token check skipped.');
  }

  // ── Browser context with optional preview auth ────────────────────────
  const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  try {
    if (config.environment === 'preview') {
      const auth = requireAuthConfig();
      await loginToPreview(page, auth, config.url);
    }

    // ── Analyse ─────────────────────────────────────────────────────────
    console.log(`[analyze] Analysing ${config.url}…`);
    const analysis = await analyzePage(page, config.url, screenshotPath, designTokens);

    if (analysis.loadError) {
      console.warn(`[analyze] ⚠ Page load reported an error: ${analysis.loadError}`);
    }

    // ── Build report ────────────────────────────────────────────────────
    const html = generateSinglePageReport(analysis, {
      environment:  config.environment,
      figmaFileKey: config.figmaFileKey,
    });
    fs.writeFileSync(outputPath, html, 'utf8');

    await testInfo.attach('Analysis Report (HTML)', {
      path: outputPath, contentType: 'text/html',
    });
    if (fs.existsSync(screenshotPath)) {
      await testInfo.attach('Page Screenshot', {
        path: screenshotPath, contentType: 'image/png',
      });
    }

    // ── Summary ─────────────────────────────────────────────────────────
    const axeTotal       = analysis.axeViolations.length;
    const axeCritical    = analysis.axeViolations.filter((v) => v.impact === 'critical').length;
    const tokenColors    = analysis.designTokenViolations?.unknownColors.length ?? 0;
    const tokenFonts     = analysis.designTokenViolations?.unknownFonts.length  ?? 0;

    console.log('\n' + '='.repeat(60));
    console.log(`ANALYSIS SUMMARY — ${config.environment}: ${config.url}`);
    console.log('='.repeat(60));
    console.log(`HTTP status:                    ${analysis.statusCode}`);
    console.log(`Axe violations (total / crit):  ${axeTotal} / ${axeCritical}`);
    if (analysis.designTokenViolations) {
      console.log(`Token color violations:         ${tokenColors}`);
      console.log(`Token font violations:          ${tokenFonts}`);
    } else {
      console.log('Token check:                    not run');
    }
    console.log('='.repeat(60));
    console.log(`Report saved to: ${outputPath}\n`);
  } finally {
    await ctx.close();
  }
});

/** Counts the leaf entries (color hex strings, typography objects) in a nested token tree. */
function countLeafs(obj: unknown): number {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    // A typography leaf is recognised by the presence of a fontFamily string;
    // a color leaf is a string anywhere in the tree.
    if (typeof rec.fontFamily === 'string') return 1;
    return Object.values(rec).reduce<number>((sum, v) => sum + countLeafs(v), 0);
  }
  return typeof obj === 'string' ? 1 : 0;
}
