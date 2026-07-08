import { chromium } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuthConfig, setupPreviewAuth } from './auth';

/**
 * Playwright global setup — runs once in the main process before any worker starts.
 *
 * Collects preview URLs from every known config source, logs in to each unique
 * preview hostname exactly once, and writes IAP session cookies to
 * .auth/<hostname>.json.  Workers then restore state via storageState without
 * ever touching the Firebase email-lookup endpoint.
 */
export default async function globalSetup(): Promise<void> {
  // Ensure env vars are available (playwright.config.ts already calls this,
  // but global setup runs in the same process so they're inherited; call again
  // as a safe fallback for direct invocation).
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });

  const auth = requireAuthConfig();

  // ── Collect preview URLs from all known config sources ──────────────────────
  const allPairs: Array<{ previewUrl: string }> = [];

  // Source 1: urls.config.json  (used by tests/compare-urls.spec.ts)
  const urlsConfigPath = path.resolve(
    process.cwd(),
    process.env.URLS_CONFIG?.trim() ?? 'urls.config.json',
  );
  if (fs.existsSync(urlsConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(urlsConfigPath, 'utf8'));
      if (Array.isArray(parsed.comparisons)) {
        allPairs.push(...(parsed.comparisons as Array<{ previewUrl: string }>));
        console.log(`[GlobalSetup] Loaded ${parsed.comparisons.length} pair(s) from urls.config.json`);
      }
    } catch {
      console.warn('[GlobalSetup] Could not parse urls.config.json — skipping');
    }
  }

  // Source 2: sites/oscar-mayer/pages.json  (used by sites/oscar-mayer/compare.spec.ts)
  const oscarMayerPath = path.resolve(process.cwd(), 'sites', 'oscar-mayer', 'pages.json');
  if (fs.existsSync(oscarMayerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(oscarMayerPath, 'utf8'));
      if (Array.isArray(parsed.comparisons)) {
        allPairs.push(...(parsed.comparisons as Array<{ previewUrl: string }>));
        console.log(`[GlobalSetup] Loaded ${parsed.comparisons.length} pair(s) from oscar-mayer/pages.json`);
      }
    } catch {
      console.warn('[GlobalSetup] Could not parse oscar-mayer/pages.json — skipping');
    }
  }

  // Source 3: forms.config.json  (used by tests/test-forms.spec.ts)
  const formsConfigPath = path.resolve(process.cwd(), 'forms.config.json');
  if (fs.existsSync(formsConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(formsConfigPath, 'utf8'));
      if (Array.isArray(parsed.forms)) {
        const previewForms = (parsed.forms as Array<{ url: string; environment: string }>)
          .filter((f) => f.environment?.toLowerCase() === 'preview' && f.url);
        previewForms.forEach((f) => allPairs.push({ previewUrl: f.url }));
        if (previewForms.length > 0) {
          console.log(`[GlobalSetup] Loaded ${previewForms.length} preview form URL(s) from forms.config.json`);
        }
      }
    } catch {
      console.warn('[GlobalSetup] Could not parse forms.config.json — skipping');
    }
  }

  if (allPairs.length === 0) {
    console.log('\n[GlobalSetup] No preview URLs found — skipping auth setup\n');
    return;
  }

  // ── Log in to each unique hostname once ─────────────────────────────────────
  const browser = await chromium.launch();
  try {
    await setupPreviewAuth(browser, auth, allPairs);
  } finally {
    await browser.close();
  }
}
