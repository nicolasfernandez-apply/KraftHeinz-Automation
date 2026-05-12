import { Browser, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

export interface AuthConfig {
  username: string;
  password: string;
}

/**
 * Maximum number of login attempts (initial + retries). Cloudflare and IAP
 * occasionally serve interstitial pages or transient 5xx responses on the
 * Preview environment — retrying clears almost all of these.
 */
const MAX_LOGIN_ATTEMPTS = 3;

/** Delay between login attempts. */
const LOGIN_RETRY_DELAY_MS = 5_000;

/**
 * Thrown when the sign-in form rejected the credentials. Retrying is pointless
 * — the password is wrong — so the retry wrapper rethrows this immediately.
 */
class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

/**
 * Returns the preview auth credentials from env vars.
 * Throws immediately if either is missing — login is mandatory for the PRV environment.
 */
export function requireAuthConfig(): AuthConfig {
  const username = process.env.PREVIEW_USERNAME?.trim();
  const password = process.env.PREVIEW_PASSWORD?.trim();

  if (!username || !password) {
    throw new Error(
      '\n' +
      '  PREVIEW_USERNAME and PREVIEW_PASSWORD are required.\n' +
      '  The PRV environment is protected by Google IAP and always requires login.\n' +
      '  Add both variables to your .env file and re-run.\n',
    );
  }

  return { username, password };
}

/**
 * Logs in to the KraftHeinz PRV environment via Google Cloud IAP + GCIP.
 *
 * Flow:
 *   1. Navigate to the target URL → IAP redirects to the GCIP hosted login UI
 *   2. Fill email and click Next
 *   3. Wait for the password step, fill password and click Sign In
 *   4. Wait until IAP redirects back to the heinz.prv.kraftheinz.com domain
 *
 * Retries up to MAX_LOGIN_ATTEMPTS times on transient errors (Cloudflare
 * interstitials, IAP redirect timeouts, network blips). A definitive
 * credential rejection is not retried.
 *
 * Call this BEFORE analyzePage() so the IAP session cookie is in place.
 */
export async function loginToPreview(
  page: Page,
  auth: AuthConfig,
  targetUrl: string,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      await attemptLogin(page, auth, targetUrl);
      return;
    } catch (err) {
      // Wrong username/password — no amount of retrying will fix this.
      if (err instanceof CredentialsError) throw err;

      lastError = err;
      const firstLine = ((err as Error).message ?? String(err)).split('\n')[0];
      console.warn(`  [Auth] Attempt ${attempt}/${MAX_LOGIN_ATTEMPTS} failed: ${firstLine}`);

      if (attempt < MAX_LOGIN_ATTEMPTS) {
        console.warn(
          `  [Auth] Retrying in ${LOGIN_RETRY_DELAY_MS / 1000}s — ` +
          `often a transient Cloudflare/IAP issue on the Preview environment…\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS));
      }
    }
  }

  throw lastError;
}

/** Single login attempt — see loginToPreview for retry behaviour. */
async function attemptLogin(
  page: Page,
  auth: AuthConfig,
  targetUrl: string,
): Promise<void> {
  console.log(`\n  [Auth] Navigating to PRV environment → IAP will redirect to login`);
  console.log(`  [Auth] Target: ${targetUrl}`);

  // Navigate to the protected URL — IAP intercepts and redirects to the GCIP hosted UI
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for the JS-rendered login page to fully load
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  // If IAP did not redirect us to a login page the session is already valid —
  // skip the login form entirely (avoids Firebase email-lookup quota hits).
  const currentUrl = page.url();
  const isLoginPage =
    currentUrl.includes('.run.app') ||
    currentUrl.includes('iap.googleapis.com') ||
    currentUrl.includes('accounts.google.com');

  if (!isLoginPage) {
    console.log(`  [Auth] Session already valid — skipping login\n`);
    return;
  }

  console.log(`  [Auth] Login page loaded: ${currentUrl}`);

  // ── Step 1: Email ───────────────────────────────────────────────────────────
  const emailField = page.locator('input[type="email"]').first();

  try {
    await emailField.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    await saveDebugScreenshot(page, 'auth-step1-no-email-field');
    throw new Error(
      `  [Auth] Could not find email input on the login page.\n` +
      `  Current URL: ${page.url()}\n` +
      `  A screenshot was saved to reports/screenshots/auth-step1-no-email-field.png\n` +
      `  Run "npm run compare:headed" to watch the browser live.`,
    );
  }

  await emailField.fill(auth.username);
  console.log(`  [Auth] Email entered — clicking Next`);

  // Click Next / Continue (the first submit button on the email step)
  await page.locator('button[type="submit"]').first().click();

  // ── Step 2: Password ────────────────────────────────────────────────────────
  const passwordField = page.locator('input[type="password"]').first();

  try {
    await passwordField.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    await saveDebugScreenshot(page, 'auth-step2-no-password-field');
    throw new Error(
      `  [Auth] Password field did not appear after the email step.\n` +
      `  This can mean the email was not recognised or the login UI changed.\n` +
      `  Current URL: ${page.url()}\n` +
      `  A screenshot was saved to reports/screenshots/auth-step2-no-password-field.png`,
    );
  }

  await passwordField.fill(auth.password);
  console.log(`  [Auth] Password entered — clicking Sign In`);

  // Click Sign In (first submit button on the password step)
  await page.locator('button[type="submit"]').first().click();

  // ── Wait for IAP to redirect back to the app ────────────────────────────────
  try {
    await page.waitForURL(
      (url) =>
        !url.hostname.includes('.run.app') &&
        !url.hostname.includes('iap.googleapis.com') &&
        !url.hostname.includes('accounts.google.com'),
      { timeout: 30_000 },
    );
  } catch {
    // Check if the current page looks like a login-failure error
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const looksLikeFail = /invalid|incorrect|wrong|failed|denied|error/i.test(bodyText);

    await saveDebugScreenshot(page, 'auth-sign-in-result');

    if (looksLikeFail) {
      throw new CredentialsError(
        `  [Auth] Login failed — credentials appear to be incorrect.\n` +
        `  Check PREVIEW_USERNAME and PREVIEW_PASSWORD in your .env file.\n` +
        `  A screenshot was saved to reports/screenshots/auth-sign-in-result.png`,
      );
    }

    throw new Error(
      `  [Auth] Sign-in submitted but IAP did not redirect back to the app within 30 s.\n` +
      `  Current URL: ${page.url()}\n` +
      `  A screenshot was saved to reports/screenshots/auth-sign-in-result.png\n` +
      `  Run "npm run compare:headed" to watch the browser live.`,
    );
  }

  // Let the page finish loading after the IAP redirect
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  console.log(`  [Auth] Login complete — now at: ${page.url()}\n`);
}

/**
 * Logs in to each unique PRV hostname found in urlPairs — exactly once per
 * hostname — saves the IAP session cookies to .auth/<hostname>.json, and
 * returns a Map<hostname, storageStatePath>.
 *
 * Call this in test.beforeAll.  Each test then creates its preview context
 * with `storageState: stateMap.get(hostname)`, so loginToPreview detects the
 * valid session and returns immediately without triggering a Firebase
 * email-lookup (which is subject to a strict per-hour quota).
 */
export async function setupPreviewAuth(
  browser: Browser,
  auth: AuthConfig,
  urlPairs: ReadonlyArray<{ previewUrl: string }>,
): Promise<Map<string, string>> {
  const stateDir = path.join(process.cwd(), '.auth');
  fs.mkdirSync(stateDir, { recursive: true });

  const stateByHostname = new Map<string, string>();
  const seen = new Set<string>();

  for (const pair of urlPairs) {
    let hostname: string;
    try { hostname = new URL(pair.previewUrl).hostname; } catch { continue; }
    if (seen.has(hostname)) continue;
    seen.add(hostname);

    const statePath = path.join(stateDir, `${hostname}.json`);

    // If a state file from this process already exists (e.g. Playwright restarted
    // the worker after a test failure), reuse it — the session is still valid and
    // re-logging in would consume another Firebase email-lookup quota slot.
    if (fs.existsSync(statePath)) {
      stateByHostname.set(hostname, statePath);
      console.log(`[Auth] Reusing existing session for ${hostname}`);
      continue;
    }

    console.log(`\n[Auth] Logging in to ${hostname} (once for all tests on this domain)…`);

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await loginToPreview(page, auth, pair.previewUrl);
    await ctx.storageState({ path: statePath });
    await ctx.close();

    stateByHostname.set(hostname, statePath);
    console.log(`[Auth] Session saved → ${statePath}`);
  }

  return stateByHostname;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function saveDebugScreenshot(page: Page, name: string): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'reports', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${name}.png`);
    await page.screenshot({ path: dest, fullPage: true });
    console.log(`  [Auth] Debug screenshot saved: ${dest}`);
  } catch {
    // Non-fatal — don't mask the original error
  }
}
