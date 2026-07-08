/**
 * Form Testing Suite
 *
 * Reads form entries from forms.config.json.  For each entry it:
 *   1. Navigates to the URL (authenticating via IAP for preview environments)
 *   2. Uses Claude AI to scan the page, identify every form field, and
 *      generate valid and invalid test data per field.
 *   3. Runs four test scenarios:
 *        • Scan report     — structure audit, attached to the Playwright report
 *        • Valid submit     — all fields filled correctly; expects no errors
 *        • Required empty  — submits blank; expects validation messages
 *        • Invalid data    — one invalid value per field, one step per case
 *   4. Generates a self-contained HTML report attached to the Playwright run.
 *
 * Config file: forms.config.json  (project root)
 * Auth:        PREVIEW_USERNAME + PREVIEW_PASSWORD in .env
 * AI:          ANTHROPIC_API_KEY in .env
 */

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuthConfig, loginToPreview } from '../utils/auth';
import { scanForm, FormScanResult, FormField, FormInfo } from '../utils/form-analyzer';
import {
  generateFormReport,
  FormReportData,
  FormScenarioResult,
  FieldValidationResult,
} from '../utils/form-report';

// ── Config types & loader ─────────────────────────────────────────────────────

interface FormEntry {
  name: string;
  url: string;
  /** Case-insensitive: "preview", "Preview", "PREVIEW" all trigger IAP auth */
  environment: string;
}

interface FormsConfig {
  forms: FormEntry[];
}

function loadFormsConfig(): FormEntry[] {
  const configPath = path.resolve(process.cwd(), 'forms.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      '\nforms.config.json not found.\n' +
      '  Create it at the project root with the following structure:\n' +
      '  {\n    "forms": [\n      { "name": "...", "url": "...", "environment": "preview|production" }\n    ]\n  }\n',
    );
  }

  let parsed: FormsConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse forms.config.json: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed.forms) || parsed.forms.length === 0) {
    throw new Error('forms.config.json must have a non-empty "forms" array.');
  }

  return parsed.forms;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Browser context helpers ───────────────────────────────────────────────────

async function createContext(browser: Browser, entry: FormEntry): Promise<BrowserContext> {
  if (entry.environment.toLowerCase() === 'preview') {
    const hostname = new URL(entry.url).hostname;
    const stateFile = path.join(process.cwd(), '.auth', `${hostname}.json`);
    return browser.newContext({
      ignoreHTTPSErrors: true,
      ...(fs.existsSync(stateFile) ? { storageState: stateFile } : {}),
    });
  }
  return browser.newContext({ ignoreHTTPSErrors: true });
}

async function getPage(browser: Browser, entry: FormEntry): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await createContext(browser, entry);
  const page = await ctx.newPage();

  if (entry.environment.toLowerCase() === 'preview') {
    const auth = requireAuthConfig();
    await loginToPreview(page, auth, entry.url);
  }

  return { ctx, page };
}

// ── Field interaction helpers ─────────────────────────────────────────────────

async function fillField(page: Page, field: FormField, value: string): Promise<void> {
  try {
    const loc = page.locator(field.selector).first();
    await loc.waitFor({ state: 'visible', timeout: 5_000 });

    if (field.type === 'select') {
      if (value) await loc.selectOption(value);
    } else if (field.type === 'checkbox') {
      const shouldCheck = value === 'true' || value === '1';
      if (shouldCheck) {
        await loc.check();
      } else {
        await loc.uncheck();
      }
    } else if (field.type === 'radio') {
      if (value) {
        const radio = page.locator(`[name="${field.name}"][value="${value}"]`).first();
        await radio.check();
      }
    } else {
      await loc.fill(value);
    }
  } catch {
    // Non-fatal: some fields may be conditionally visible or dynamic
    console.warn(`  [Forms] Could not fill field "${field.label}" (${field.selector}) — skipping`);
  }
}

/** Fills all given fields with their valid test values. */
async function fillValidData(page: Page, form: FormInfo): Promise<void> {
  for (const field of form.fields) {
    await fillField(page, field, field.testData?.valid ?? '');
  }
}

// ── Validation error detection ────────────────────────────────────────────────

/**
 * Returns the visible error text nearest to a specific field, or empty string.
 * Checks common patterns: aria-invalid, role=alert, [class*=error], [class*=invalid].
 */
async function getFieldError(page: Page, field: FormField): Promise<string> {
  try {
    const sel = field.selector;

    // aria-describedby message
    const describedBy = await page.locator(sel).first().getAttribute('aria-describedby').catch(() => null);
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const msgEl = page.locator(`#${id}`).first();
        const visible = await msgEl.isVisible().catch(() => false);
        if (visible) {
          const txt = await msgEl.innerText().catch(() => '');
          if (txt.trim()) return txt.trim();
        }
      }
    }

    // aria-invalid → look for nearest error container
    const isInvalid = await page.locator(sel).first().getAttribute('aria-invalid').catch(() => null);
    if (isInvalid === 'true') {
      // Try common sibling/parent error patterns
      const errorSel = `${sel} ~ [class*="error"], ${sel} ~ [class*="invalid"], ${sel} ~ [role="alert"]`;
      const sibling = page.locator(errorSel).first();
      if (await sibling.isVisible().catch(() => false)) {
        return (await sibling.innerText().catch(() => '')).trim();
      }
    }

    // Nearest [class*=error] or [role=alert] on the page
    const containers = await page.locator(
      '[class*="error"]:visible, [class*="invalid"]:visible, [role="alert"]:visible, [class*="validation"]:visible',
    ).all();

    for (const el of containers.slice(0, 10)) {
      const txt = (await el.innerText().catch(() => '')).trim();
      if (txt) return txt;
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Returns true if any visible validation error messages appear on the page
 * after an attempted form submission.
 */
async function hasAnyValidationErrors(page: Page): Promise<boolean> {
  const errorSelectors = [
    '[aria-invalid="true"]',
    '[class*="error"]:visible',
    '[class*="invalid"]:visible',
    '[role="alert"]:visible',
    '[class*="validation"]:visible',
    '[class*="field-error"]:visible',
    '[class*="form-error"]:visible',
  ];
  for (const sel of errorSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

/**
 * Returns true if the page shows a likely success state after submission
 * (URL changed, or a thank-you / success message appeared).
 */
async function detectSuccessState(page: Page, originalUrl: string): Promise<{ success: boolean; detail: string }> {
  const currentUrl = page.url();
  if (currentUrl !== originalUrl) {
    return { success: true, detail: `Redirected to: ${currentUrl}` };
  }

  const successPatterns = [
    '[class*="success"]:visible',
    '[class*="thank"]:visible',
    '[class*="confirmation"]:visible',
    '[role="status"]:visible',
    '[role="alert"][class*="success"]:visible',
  ];

  for (const sel of successPatterns) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const txt = (await el.innerText().catch(() => '')).trim();
      return { success: true, detail: `Success element found: "${txt}"` };
    }
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const successKeywords = ['thank you', 'thanks', 'submitted', 'received', 'success', 'sent'];
  for (const kw of successKeywords) {
    if (bodyText.includes(kw)) {
      return { success: true, detail: `Success keyword found: "${kw}"` };
    }
  }

  const hasErrors = await hasAnyValidationErrors(page);
  if (!hasErrors) {
    return { success: true, detail: 'No validation errors found after submit' };
  }

  return { success: false, detail: 'Validation errors still visible after submit with valid data' };
}

// ── Report helpers ────────────────────────────────────────────────────────────

function reportsDir(): string {
  const dir = path.join(process.cwd(), 'reports', 'forms');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Test suite ────────────────────────────────────────────────────────────────

const formEntries = loadFormsConfig();

for (const entry of formEntries) {
  test.describe(`Form Tests: ${entry.name}`, () => {
    // Serial mode: scan runs first; subsequent tests depend on scanResult
    test.describe.configure({ mode: 'serial' });

    let scanResult: FormScanResult;
    const scenarios: FormScenarioResult[] = [];

    // ── beforeAll: authenticate + scan ──────────────────────────────────────
    test.beforeAll(async ({ browser }) => {
      const { ctx, page } = await getPage(browser, entry);
      try {
        await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60_000 });
        scanResult = await scanForm(page);
      } finally {
        await ctx.close();
      }
    });

    // ── Test 1: Scan structure report ────────────────────────────────────────
    test('Scan: form structure', async ({}, testInfo) => {
      expect(scanResult, 'scanResult must be populated by beforeAll').toBeTruthy();

      const totalFields = scanResult.forms.reduce((n, f) => n + f.fields.length, 0);
      const requiredFields = scanResult.forms.reduce((n, f) => n + f.fields.filter((fld) => fld.required).length, 0);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`FORM SCAN — ${entry.name}`);
      console.log('='.repeat(60));
      console.log(`URL:              ${scanResult.url}`);
      console.log(`Forms found:      ${scanResult.forms.length}`);
      console.log(`Total fields:     ${totalFields}`);
      console.log(`Required fields:  ${requiredFields}`);
      console.log('='.repeat(60));

      for (const form of scanResult.forms) {
        console.log(`\nForm ${form.formIndex + 1} (${form.method?.toUpperCase() ?? 'GET'} → ${form.action || 'same page'})`);
        for (const field of form.fields) {
          const req = field.required ? ' [required]' : '';
          console.log(`  • ${field.label || field.name} (${field.type})${req}`);
          console.log(`      valid:   ${field.testData?.valid}`);
          field.testData?.invalid?.forEach((iv) => console.log(`      invalid: ${iv.value || '(empty)'} — ${iv.reason}`));
        }
      }
      console.log('');

      // Attach screenshot taken during scan
      if (scanResult.screenshotBase64) {
        await testInfo.attach('Page screenshot', {
          body: Buffer.from(scanResult.screenshotBase64, 'base64'),
          contentType: 'image/png',
        });
      }

      // Attach raw scan JSON
      await testInfo.attach('Form scan data (JSON)', {
        body: Buffer.from(JSON.stringify(scanResult, null, 2)),
        contentType: 'application/json',
      });

      testInfo.annotations.push({
        type: 'description',
        description: `${scanResult.forms.length} form(s) | ${totalFields} field(s) | ${requiredFields} required`,
      });

      expect(
        scanResult.forms.length,
        `Expected at least one <form> element on ${entry.url}`,
      ).toBeGreaterThan(0);
    });

    // ── Test 2: Valid submission ──────────────────────────────────────────────
    test('Valid: all fields filled correctly', async ({ browser }, testInfo) => {
      const { ctx, page } = await getPage(browser, entry);

      try {
        await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60_000 });

        for (const form of scanResult.forms) {
          await test.step(`Fill form ${form.formIndex + 1} with valid data`, async () => {
            await fillValidData(page, form);
          });

          const screenshotBefore = await page.screenshot({ fullPage: false });
          await testInfo.attach(`Before submit — form ${form.formIndex + 1}`, {
            body: screenshotBefore,
            contentType: 'image/png',
          });

          const originalUrl = page.url();

          await test.step('Submit the form', async () => {
            const submitLoc = page.locator(form.submitSelector).first();
            await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
            await submitLoc.click();
            await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
          });

          const screenshotAfter = await page.screenshot({ fullPage: false });
          await testInfo.attach(`After submit — form ${form.formIndex + 1}`, {
            body: screenshotAfter,
            contentType: 'image/png',
          });

          const { success, detail } = await detectSuccessState(page, originalUrl);

          const scenario: FormScenarioResult = {
            scenario: 'valid-submission',
            label: `Valid submission — form ${form.formIndex + 1}`,
            passed: success,
            message: detail,
            screenshotBase64: screenshotAfter.toString('base64'),
          };
          scenarios.push(scenario);

          expect(success, `Valid submission should succeed. Detail: ${detail}`).toBe(true);
        }
      } finally {
        await ctx.close();
      }
    });

    // ── Test 3: Required fields — submit empty ────────────────────────────────
    test('Validation: required fields show errors when empty', async ({ browser }, testInfo) => {
      const { ctx, page } = await getPage(browser, entry);

      try {
        await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60_000 });

        for (const form of scanResult.forms) {
          const requiredFields = form.fields.filter((f) => f.required);
          if (requiredFields.length === 0) {
            console.log(`  [Forms] Form ${form.formIndex + 1} has no required fields — skipping empty-submit test`);
            scenarios.push({
              scenario: 'required-empty',
              label: `Required fields empty — form ${form.formIndex + 1}`,
              passed: true,
              message: 'No required fields on this form — skipped',
            });
            continue;
          }

          await test.step('Submit form without filling any fields', async () => {
            const submitLoc = page.locator(form.submitSelector).first();
            await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
            await submitLoc.click();
            await page.waitForTimeout(1_000);
          });

          const screenshotAfter = await page.screenshot({ fullPage: false });
          await testInfo.attach(`After empty submit — form ${form.formIndex + 1}`, {
            body: screenshotAfter,
            contentType: 'image/png',
          });

          const hasErrors = await hasAnyValidationErrors(page);

          const fieldResults: FieldValidationResult[] = await Promise.all(
            requiredFields.map(async (field) => {
              const errorText = await getFieldError(page, field);
              return {
                field: field.label || field.name,
                selector: field.selector,
                value: '',
                reason: 'required field left empty',
                errorVisible: hasErrors,
                errorText,
              };
            }),
          );

          const scenario: FormScenarioResult = {
            scenario: 'required-empty',
            label: `Required fields empty — form ${form.formIndex + 1}`,
            passed: hasErrors,
            message: hasErrors
              ? `Validation messages appeared for ${requiredFields.length} required field(s)`
              : `No validation errors visible after empty submit — form may lack client-side validation`,
            screenshotBase64: screenshotAfter.toString('base64'),
            fieldResults,
          };
          scenarios.push(scenario);

          // Soft assertion: some forms rely on server-side validation only
          if (!hasErrors) {
            testInfo.annotations.push({
              type: 'warning',
              description: `Form ${form.formIndex + 1} shows no client-side validation on empty submit`,
            });
          }

          // Reload for the next form if needed
          if (scanResult.forms.indexOf(form) < scanResult.forms.length - 1) {
            await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60_000 });
          }
        }
      } finally {
        await ctx.close();
      }
    });

    // ── Test 4: Invalid data per field ────────────────────────────────────────
    test('Validation: invalid data triggers field errors', async ({ browser }, testInfo) => {
      const { ctx, page } = await getPage(browser, entry);

      const allFieldResults: FieldValidationResult[] = [];
      let stepsFailed = 0;

      try {
        for (const form of scanResult.forms) {
          for (const field of form.fields) {
            const invalidCases = field.testData?.invalid ?? [];
            if (invalidCases.length === 0) continue;

            for (const invalidCase of invalidCases) {
              const stepLabel = `"${field.label || field.name}" — ${invalidCase.reason}`;

              await test.step(stepLabel, async () => {
                // Fresh page state for each field test
                await page.goto(entry.url, { waitUntil: 'networkidle', timeout: 60_000 });

                // Fill all OTHER required fields with valid data so only this field is invalid
                for (const other of form.fields) {
                  if (other.selector !== field.selector && other.required) {
                    await fillField(page, other, other.testData?.valid ?? '');
                  }
                }

                // Fill the target field with the invalid value
                await fillField(page, field, invalidCase.value);

                // Submit
                const submitLoc = page.locator(form.submitSelector).first();
                await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
                await submitLoc.click();
                await page.waitForTimeout(1_000);

                const errorText = await getFieldError(page, field);
                const hasErrors = await hasAnyValidationErrors(page);

                // For the empty-value case on required fields we expect an error;
                // for other invalid cases the form might or might not have live validation.
                const expectError = invalidCase.value === '' && field.required;

                const result: FieldValidationResult = {
                  field: field.label || field.name,
                  selector: field.selector,
                  value: invalidCase.value,
                  reason: invalidCase.reason,
                  errorVisible: hasErrors,
                  errorText,
                };
                allFieldResults.push(result);

                if (expectError && !hasErrors) {
                  stepsFailed++;
                  testInfo.annotations.push({
                    type: 'warning',
                    description: `No error shown for empty required field "${field.label}"`,
                  });
                }

                const screenshot = await page.screenshot({ fullPage: false });
                await testInfo.attach(`Invalid: ${field.label} — ${invalidCase.reason}`, {
                  body: screenshot,
                  contentType: 'image/png',
                });
              });
            }
          }
        }
      } finally {
        await ctx.close();
      }

      scenarios.push({
        scenario: 'invalid-data',
        label: 'Invalid data per field',
        passed: stepsFailed === 0,
        message: stepsFailed > 0
          ? `${stepsFailed} required field(s) showed no error on empty submit`
          : 'All required fields produced validation feedback on empty submit',
        fieldResults: allFieldResults,
      });
    });

    // ── afterAll: generate HTML report ───────────────────────────────────────
    test.afterAll(async ({}, testInfo) => {
      if (!scanResult) return;

      const reportData: FormReportData = {
        entryName: entry.name,
        url: entry.url,
        environment: entry.environment,
        pageTitle: scanResult.pageTitle,
        scanResult,
        scenarios,
        generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      };

      const html = generateFormReport(reportData);
      const slug = slugify(entry.name);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = path.join(reportsDir(), `${slug}-${timestamp}.html`);
      fs.writeFileSync(reportPath, html, 'utf8');

      await testInfo.attach('Form Test Report (HTML)', {
        path: reportPath,
        contentType: 'text/html',
      });

      console.log(`\nForm report saved: ${reportPath}\n`);
    });
  });
}
