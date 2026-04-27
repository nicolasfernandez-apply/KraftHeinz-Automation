# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sites/oscar-mayer/compare.spec.ts >> Oscar Mayer — Preview vs Production >> Products › 00044700095959 Shaved Extra Lean Smoked Turkey Breast Lunch Meat Twin Pack
- Location: sites/oscar-mayer/compare.spec.ts:47:9

# Error details

```
Error:   [Auth] Password field did not appear after the email step.
  This can mean the email was not recognised or the login UI changed.
  Current URL: https://iap-gcip-hosted-ui-oscarmayer-prv-cloudrun-bes-ex-znavqvfkgq-uk.a.run.app/?apiKey=AIzaSyBbW26rMRY4F6i7mOIhRsVnlIZXCz6rTW4&mode=login&tid=_785562255299&redirect_uri=https://iap.googleapis.com/v1beta1/gcip/resources/A49DB6475CDBBB86:handleRedirect&state=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkkzZGw0QSJ9.ADfE0mPp5LiAWYwbKRo9H_hp-1fUhPLlVvmC5NnIu6ll5dbeAloFI06U5nn-ZdlMv7B-zoHT21oSLdzENuRTgBlRBThh-rbpBIEzvWjLJRlHOBR337GpXwHis8VSdGdBeDTErxg9F1Cw81VLHi44EJt4LdiTmN-lYrbTxoj72Q_DZHxi4yWFySj7uKvys-POl2JRIzWaajGt_bONzAv6QdiMiUBYkdOiB0CXrCOeIpF2832YZFFS5UBBwmCTjjL8L32y_bmrxHuvW0TlQwdRQQT7AzltjIDbFm9Pxcy5NrCIMoo5FSju65thYKLStlnoOBxbgdP25OxjOX7X0VWD59k2RVOLwoCxQKAYW0pDYmVcJJJEfrG3DJJID9pmuKr6Qh1YU_fzkH2z-9xFwrHeyzX3WLhAXK1Lult9t8YCGY_KTUlb5sVozb29IqyFAVR5h7M_TqIlLdph2cCzWmY_8fUUiedjdRD15xtkXYO8zV7qlDPoY1ruo3GzzWqf6QtRW45f9jVKOP5aP76cyrDLaJYBjn19D6R3FYgS0GcCNKwcgVdVRbfp0gk8jpTdD0v-ZfSP1FwpT2g8mHVDa6HLzIZc1NteBl6Ie10tP83NnMMnXPtML4hnjwIDHHQ3dWIEqLoOxVYmyaP5c8VwqGgibsihtQvuQRSx5oCe4M7PxibiBaf3RYtFspO-9ee0HIuNnh4KnOAt7aUuKR-qTX5cvOgApl3h90Pt4LQyjyRMtAsPxQVK3nd5IHbzPN-ee_a_qVrjjWdrHtAkhxvBWW799S6i2jZIWQbVV4zUKhC_Dw4Oc2Df2Gr4KG-Xa13qS7P4oln_Qm1PXd7U9LAhPz--0rW55Nm_RA5O0s5EeBC3KvbytzIA3Z64v1pQfbVCelHj8ZoqIVo0ZKgpKAESkoo4uPW7pBvXLjHyVG0klDsu-GFKUJ1SBz38aC4VYv41NbVjzd5O0tiLqSqyUE4o_FrBLnpKG_5oWjSgLQMHXRU1Eal9joIxCjzcQemXgC0YhxpgO3TJsQMgqJJRO6-7bKBJaE2AOIGSIqBIhIqar4tUuUCeSa0Ym-9ZEqL52X0__kbuGukb.7RhvjwqSkLpnK8unfWvPBqNYhKHBoPbhYMjX3GP9FVFHDHJyAdZ3ig82TDJvDTL49qU6X68GxMMip0HRMaT5PA
  A screenshot was saved to reports/screenshots/auth-step2-no-password-field.png
```

# Test source

```ts
  1   | import { Page } from '@playwright/test';
  2   | import * as path from 'path';
  3   | import * as fs from 'fs';
  4   | 
  5   | export interface AuthConfig {
  6   |   username: string;
  7   |   password: string;
  8   | }
  9   | 
  10  | /**
  11  |  * Returns the preview auth credentials from env vars.
  12  |  * Throws immediately if either is missing — login is mandatory for the PRV environment.
  13  |  */
  14  | export function requireAuthConfig(): AuthConfig {
  15  |   const username = process.env.PREVIEW_USERNAME?.trim();
  16  |   const password = process.env.PREVIEW_PASSWORD?.trim();
  17  | 
  18  |   if (!username || !password) {
  19  |     throw new Error(
  20  |       '\n' +
  21  |       '  PREVIEW_USERNAME and PREVIEW_PASSWORD are required.\n' +
  22  |       '  The PRV environment is protected by Google IAP and always requires login.\n' +
  23  |       '  Add both variables to your .env file and re-run.\n',
  24  |     );
  25  |   }
  26  | 
  27  |   return { username, password };
  28  | }
  29  | 
  30  | /**
  31  |  * Logs in to the KraftHeinz PRV environment via Google Cloud IAP + GCIP.
  32  |  *
  33  |  * Flow:
  34  |  *   1. Navigate to the target URL → IAP redirects to the GCIP hosted login UI
  35  |  *   2. Fill email and click Next
  36  |  *   3. Wait for the password step, fill password and click Sign In
  37  |  *   4. Wait until IAP redirects back to the heinz.prv.kraftheinz.com domain
  38  |  *
  39  |  * Call this BEFORE analyzePage() so the IAP session cookie is in place.
  40  |  */
  41  | export async function loginToPreview(
  42  |   page: Page,
  43  |   auth: AuthConfig,
  44  |   targetUrl: string,
  45  | ): Promise<void> {
  46  |   console.log(`\n  [Auth] Navigating to PRV environment → IAP will redirect to login`);
  47  |   console.log(`  [Auth] Target: ${targetUrl}`);
  48  | 
  49  |   // Navigate to the protected URL — IAP intercepts and redirects to the GCIP hosted UI
  50  |   await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  51  | 
  52  |   // Wait for the JS-rendered login page to fully load
  53  |   await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  54  |   console.log(`  [Auth] Login page loaded: ${page.url()}`);
  55  | 
  56  |   // ── Step 1: Email ───────────────────────────────────────────────────────────
  57  |   const emailField = page.locator('input[type="email"]').first();
  58  | 
  59  |   try {
  60  |     await emailField.waitFor({ state: 'visible', timeout: 20_000 });
  61  |   } catch {
  62  |     await saveDebugScreenshot(page, 'auth-step1-no-email-field');
  63  |     throw new Error(
  64  |       `  [Auth] Could not find email input on the login page.\n` +
  65  |       `  Current URL: ${page.url()}\n` +
  66  |       `  A screenshot was saved to reports/screenshots/auth-step1-no-email-field.png\n` +
  67  |       `  Run "npm run compare:headed" to watch the browser live.`,
  68  |     );
  69  |   }
  70  | 
  71  |   await emailField.fill(auth.username);
  72  |   console.log(`  [Auth] Email entered — clicking Next`);
  73  | 
  74  |   // Click Next / Continue (the first submit button on the email step)
  75  |   await page.locator('button[type="submit"]').first().click();
  76  | 
  77  |   // ── Step 2: Password ────────────────────────────────────────────────────────
  78  |   const passwordField = page.locator('input[type="password"]').first();
  79  | 
  80  |   try {
  81  |     await passwordField.waitFor({ state: 'visible', timeout: 20_000 });
  82  |   } catch {
  83  |     await saveDebugScreenshot(page, 'auth-step2-no-password-field');
> 84  |     throw new Error(
      |           ^ Error:   [Auth] Password field did not appear after the email step.
  85  |       `  [Auth] Password field did not appear after the email step.\n` +
  86  |       `  This can mean the email was not recognised or the login UI changed.\n` +
  87  |       `  Current URL: ${page.url()}\n` +
  88  |       `  A screenshot was saved to reports/screenshots/auth-step2-no-password-field.png`,
  89  |     );
  90  |   }
  91  | 
  92  |   await passwordField.fill(auth.password);
  93  |   console.log(`  [Auth] Password entered — clicking Sign In`);
  94  | 
  95  |   // Click Sign In (first submit button on the password step)
  96  |   await page.locator('button[type="submit"]').first().click();
  97  | 
  98  |   // ── Wait for IAP to redirect back to the app ────────────────────────────────
  99  |   try {
  100 |     await page.waitForURL(
  101 |       (url) =>
  102 |         !url.hostname.includes('.run.app') &&
  103 |         !url.hostname.includes('iap.googleapis.com') &&
  104 |         !url.hostname.includes('accounts.google.com'),
  105 |       { timeout: 30_000 },
  106 |     );
  107 |   } catch {
  108 |     // Check if the current page looks like a login-failure error
  109 |     const bodyText = await page.locator('body').innerText().catch(() => '');
  110 |     const looksLikeFail = /invalid|incorrect|wrong|failed|denied|error/i.test(bodyText);
  111 | 
  112 |     await saveDebugScreenshot(page, 'auth-sign-in-result');
  113 | 
  114 |     if (looksLikeFail) {
  115 |       throw new Error(
  116 |         `  [Auth] Login failed — credentials appear to be incorrect.\n` +
  117 |         `  Check PREVIEW_USERNAME and PREVIEW_PASSWORD in your .env file.\n` +
  118 |         `  A screenshot was saved to reports/screenshots/auth-sign-in-result.png`,
  119 |       );
  120 |     }
  121 | 
  122 |     throw new Error(
  123 |       `  [Auth] Sign-in submitted but IAP did not redirect back to the app within 30 s.\n` +
  124 |       `  Current URL: ${page.url()}\n` +
  125 |       `  A screenshot was saved to reports/screenshots/auth-sign-in-result.png\n` +
  126 |       `  Run "npm run compare:headed" to watch the browser live.`,
  127 |     );
  128 |   }
  129 | 
  130 |   // Let the page finish loading after the IAP redirect
  131 |   await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  132 |   console.log(`  [Auth] Login complete — now at: ${page.url()}\n`);
  133 | }
  134 | 
  135 | // ── Internal helpers ──────────────────────────────────────────────────────────
  136 | 
  137 | async function saveDebugScreenshot(page: Page, name: string): Promise<void> {
  138 |   try {
  139 |     const dir = path.join(process.cwd(), 'reports', 'screenshots');
  140 |     fs.mkdirSync(dir, { recursive: true });
  141 |     const dest = path.join(dir, `${name}.png`);
  142 |     await page.screenshot({ path: dest, fullPage: true });
  143 |     console.log(`  [Auth] Debug screenshot saved: ${dest}`);
  144 |   } catch {
  145 |     // Non-fatal — don't mask the original error
  146 |   }
  147 | }
  148 | 
```