import { test } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { analyzePage }            from '../utils/analyzer';
import { loadTokenFile }          from '../utils/token-loader';
import { loginToPreview, requireAuthConfig } from '../utils/auth';
import { runPreAction } from '../utils/pre-action';
import { generateSinglePageReport } from '../utils/single-page-report';

interface AnalyzeConfig {
  /** A single URL to analyse. Mutually exclusive with `urls`. */
  url?:        string;
  /** A list of URLs to analyse in one run. Mutually exclusive with `url`. */
  urls?:       string[];
  environment: 'preview' | 'production';
  /**
   * Optional. Path (relative to repo root) to a single *.tokens.json file
   * from the central tokens/ folder — e.g.
   * "tokens/Tokens-Heinz/Heinz - Ketchup Red.tokens.json".
   * When omitted, the design-token compliance check is skipped.
   */
  tokensFile?: string;
  /**
   * Optional name of a pre-action defined in pre-actions.config.json.
   * Executed after login but before the page is analysed
   * (e.g. dismiss an age gate, select a country).
   */
  preAction?: string;
}

// Default to ./analyze.config.json so `npm run analyze` works with no env var;
// ANALYZE_CONFIG can still override it for one-off configs.
const configPath = process.env.ANALYZE_CONFIG ?? path.resolve(process.cwd(), 'analyze.config.json');
if (!fs.existsSync(configPath)) {
  throw new Error(
    `\n  Analyze config file not found: ${configPath}\n` +
    '  Either create analyze.config.json in the repo root, or point ANALYZE_CONFIG at a different file.\n',
  );
}

const config: AnalyzeConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.environment) {
  throw new Error('Config must include `environment` ("preview" | "production").');
}

// Normalise to a list so the rest of the spec doesn't need to branch.
const urls: string[] = config.urls && config.urls.length > 0
  ? config.urls
  : config.url
    ? [config.url]
    : [];

if (urls.length === 0) {
  throw new Error('Config must include `url` (string) or `urls` (string[]).');
}

// ── Design tokens (loaded once, shared across every URL) ────────────────────
// Tokens are resolved from the repo root so configs can use the same
// "tokens/Tokens-Heinz/…" paths that the site compare specs use.
let designTokens = null;
let tokenSetName: string | null = null;
if (config.tokensFile) {
  const tokenPath = path.isAbsolute(config.tokensFile)
    ? config.tokensFile
    : path.resolve(process.cwd(), config.tokensFile);
  const set = loadTokenFile(tokenPath);
  if (set) {
    designTokens = set.tokens;
    tokenSetName = set.name;
    const colorCount = countLeafs(designTokens.colors);
    console.log(`[analyze] Loaded ${colorCount} color tokens from "${set.name}".`);
  } else {
    console.warn(`[analyze] Could not load tokens from ${tokenPath} — proceeding without token check.`);
  }
} else {
  console.log('[analyze] No tokensFile in config — design token check skipped.');
}

// ── Reports directory (wiped once per run, not once per URL) ───────────────
// We do this at module load so that when the config lists multiple URLs,
// every report from this run ends up side-by-side in reports/analyze/.
const reportsDir = path.join(process.cwd(), 'reports', 'analyze');
fs.rmSync(reportsDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

for (const url of urls) {
  test(`Analyze ${config.environment.toUpperCase()} — ${url}`, async ({ browser }, testInfo) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug      = slugify(new URL(url).pathname || 'home') || 'page';
    const outputPath     = path.join(reportsDir, `${slug}-${timestamp}.html`);
    const screenshotPath = path.join(reportsDir, `${slug}-${timestamp}.png`);

    const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    try {
      if (config.environment === 'preview') {
        const auth = requireAuthConfig();
        await loginToPreview(page, auth, url);
      }

      if (config.preAction) {
        console.log(`[analyze] Running pre-action "${config.preAction}"…`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await runPreAction(page, config.preAction);
      }

      console.log(`[analyze] Analysing ${url}…`);
      const analysis = await analyzePage(page, url, screenshotPath, designTokens);

      if (analysis.loadError) {
        console.warn(`[analyze] ⚠ Page load reported an error: ${analysis.loadError}`);
      }

      const html = generateSinglePageReport(analysis, {
        environment:  config.environment,
        tokenSetName: tokenSetName ?? undefined,
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

      const axeTotal       = analysis.axeViolations.length;
      const axeCritical    = analysis.axeViolations.filter((v) => v.impact === 'critical').length;
      const tokenColors    = analysis.designTokenViolations?.unknownColors.length ?? 0;
      const tokenFonts     = analysis.designTokenViolations?.unknownFonts.length  ?? 0;

      console.log('\n' + '='.repeat(60));
      console.log(`ANALYSIS SUMMARY — ${config.environment}: ${url}`);
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
}

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
