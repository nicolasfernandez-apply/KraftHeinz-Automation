/**
 * Grammar Check Suite
 *
 * Reads page entries from grammar.config.json. For each entry it:
 *   1. Navigates to the URL (authenticating via IAP for preview environments).
 *   2. Extracts visible page text and sends it to Claude CLI.
 *   3. Claude reviews grammar, spelling, punctuation, style and clarity
 *      for the declared language and returns a structured JSON report.
 *   4. Generates a self-contained HTML report attached to the Playwright run.
 *
 * Config file: grammar.config.json  (project root)
 * Auth:        PREVIEW_USERNAME + PREVIEW_PASSWORD in .env (preview only)
 */

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuthConfig, loginToPreview } from '../utils/auth';
import { runPreAction } from '../utils/pre-action';
import { analyzeGrammar } from '../utils/grammar-analyzer';
import { generateGrammarReport } from '../utils/grammar-report';

// ── Config types & loader ─────────────────────────────────────────────────────

interface GrammarPageEntry {
  /** Human-readable label shown in the Playwright report */
  name: string;
  url: string;
  /** "preview" triggers IAP authentication; anything else skips auth */
  environment: string;
  /**
   * BCP 47 language name or tag used in the Claude prompt.
   * Examples: "English (Canadian)", "French (Canadian)", "Spanish"
   */
  language: string;
  /** Optional pre-action name from pre-actions.config.json */
  preAction?: string;
}

interface GrammarConfig {
  pages: GrammarPageEntry[];
}

function loadGrammarConfig(): GrammarPageEntry[] {
  const configPath = path.resolve(process.cwd(), 'grammar.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      '\ngrammar.config.json not found.\n' +
      '  Create it at the project root:\n' +
      '  {\n    "pages": [\n      { "name": "...", "url": "...", "environment": "preview|production", "language": "English" }\n    ]\n  }\n',
    );
  }

  let parsed: GrammarConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse grammar.config.json: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error('grammar.config.json must have a non-empty "pages" array.');
  }

  return parsed.pages;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Test suite ────────────────────────────────────────────────────────────────

const entries = loadGrammarConfig();

for (const entry of entries) {
  test(entry.name, async ({ browser }, testInfo) => {
    const isPreview = entry.environment.toLowerCase() === 'preview';

    let context = await browser.newContext();

    if (isPreview) {
      const authCfg = requireAuthConfig();
      const authPage = await context.newPage();
      await loginToPreview(authPage, authCfg, entry.url);
      await authPage.close();
    }

    const page = await context.newPage();

    console.log(`\n[Grammar] Navigating to: ${entry.url}`);
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    if (entry.preAction) {
      await runPreAction(page, entry.preAction);
    }

    console.log(`[Grammar] Analyzing grammar for language: ${entry.language}`);
    const result = await analyzeGrammar(page, entry.url, entry.language);

    const errorCount = result.issues.filter(i => i.severity === 'error').length;
    const warningCount = result.issues.filter(i => i.severity === 'warning').length;
    console.log(`[Grammar] Found ${errorCount} error(s), ${warningCount} warning(s)`);

    // Attach structured JSON for programmatic access
    await testInfo.attach('grammar-analysis.json', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(result, null, 2), 'utf8'),
    });

    // Attach the HTML report
    const html = generateGrammarReport(result);
    const reportSlug = slugify(entry.name);
    await testInfo.attach(`grammar-report-${reportSlug}.html`, {
      contentType: 'text/html',
      body: Buffer.from(html, 'utf8'),
    });

    // Optionally save report to disk alongside playwright-report
    const outDir = path.resolve(process.cwd(), 'reports/grammar-reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${reportSlug}.html`);
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`[Grammar] Report saved: ${outPath}`);

    await context.close();
  });
}
