# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sites/oscar-mayer/compare.spec.ts >> Oscar Mayer — Preview vs Production >> Products › 00044700094433 Bites Natural Hickory Smoked Uncured Ham Monterey Jack Cracker Trio Meat Cheese Snack Plate
- Location: sites/oscar-mayer/compare.spec.ts:47:9

# Error details

```
Error:   [Auth] Password field did not appear after the email step.
  This can mean the email was not recognised or the login UI changed.
  Current URL: https://iap-gcip-hosted-ui-oscarmayer-prv-cloudrun-bes-ex-znavqvfkgq-uk.a.run.app/?apiKey=AIzaSyBbW26rMRY4F6i7mOIhRsVnlIZXCz6rTW4&mode=login&tid=_785562255299&redirect_uri=https://iap.googleapis.com/v1beta1/gcip/resources/A49DB6475CDBBB86:handleRedirect&state=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkkzZGw0QSJ9.ADfE0mN7tapdMs_E7RsujJiIesd23q4y9daoB_rlNAmcuyzgOXKNdxoGnhCLopHL19TF3X0-GpZmhM4b_lP_AudXJpjgEkInXeifq8AZkqr5o1FftaxHVDVB7YPYu0OiB1TwBenpSlYjMZinfiz5hOH7ILQdbYofgoKdJ5EVFe5MDslYa1Y3hGSyn3ZsLiUsG5xBZz6l62o4OIvDe390cn67bNHAoL5PWucYFRKzYhhH3a3yu_Lg2CHNuNQlxiinHDbTMo7X4Ot1flo7Zzy3Q9TuxUfxvSB7t0zmQy8qP6NTs_T9WmAsjM5XYYBNpkcIj_e2agnsV6phnX-BcpP5YFXRDR8Gp_FYTM7esSCReL4nG4EbjPSeLc5jSkUzYRXR7X3nsThEXbZq8YjCnV2_3czjusTngnTmQD41PwflP33RK-Mj2VKFXx66StQkYcjCX-F_g0dRXwJEXXRvtnv-NPNdyR1hUmBWm-z-Z5h_SMMLaXp20ydbJooMMS2B3PArQjOTLMybIb3qDCGfu8ujdV9qPFv0KfDrCXePRuU2xMg8MiiMsVaE-6Bvypw-MoFu2rIHq61j7mPXItEmIZtSv_yaj0sTN5TtAw4yNOgxrjRlvH8WVZKwj9vkn96ibSoj5IGNG7p7Cw5z-Dpnui-umTv-Yucxxz2heCgyYFWyrXn0L0xp0UbkTMhkZh0Fs_dS0j83b6mobO_RVS-wPJIg0Nl5Rs25GcFAJVEEwEFMGs1_Vn6-oFkxtg1y518A9xHagm4YfZhknqnUoZefXW9kX5cfA7y2WA-USTlVS5rEV6DB2sw_CH2USYpGa5AEYTRd9copWmuYJxYTiF7vZiQh6ngi16R-Pfquo7a_lhWVcpePG2xf5WqOdXY49Vcwy_wCySVeP4sYiPO9O0VMksuUU8Bb8rEO5YkMyiNcUUYAHOgNL-K6bHIpvI4yMx7_Nm-aXP0Wvu6Cj9ybF6u1bixCFMAIvBvwFwKWiJjhw3WGXKAtSIoT84Zs-qB97-btyrWRXxRNku8JYz5A2JO4OVTvPyOIqmOpj5ZnX_ZhkbfEKkvfXK0B8E-quthrR8aXwbEyxSnExb62zMlaJ4IRGRlNMVYFdC0ASPr1LMxmh4thqBaBZBeGmEhtCaV1Gxo8HGW6akXPndKkR2Cc-JbPuVoH4Pd6BHpsXnH8PEp2AtKaZJE0KRbVQdo6Ea0pDJ8TAjJBHw8x.fCFE-bN2KE3NHGT5yZA2v4I-rYoSAUGgpPTSe_qHSe7Ib6zaAX5EZ0IHKcus-xW2qcX1qDbBEdCuRu_v4qimwA
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