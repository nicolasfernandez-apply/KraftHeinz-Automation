import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Page } from '@playwright/test';

// ── Public types ──────────────────────────────────────────────────────────────

export interface FieldInvalidCase {
  value: string;
  reason: string;
}

export interface FieldTestData {
  valid: string;
  invalid: FieldInvalidCase[];
}

export interface FormField {
  label: string;
  name: string;
  id: string;
  /** input type, "select", or "textarea" */
  type: string;
  required: boolean;
  placeholder: string;
  /** CSS selector that uniquely identifies this field on the page */
  selector: string;
  /** Options for select / radio inputs */
  options: string[];
  testData: FieldTestData;
}

export interface FormInfo {
  /** Ordinal index of the <form> element on the page (0-based) */
  formIndex: number;
  action: string;
  method: string;
  /** Selector for the primary submit button */
  submitSelector: string;
  fields: FormField[];
}

export interface FormScanResult {
  url: string;
  pageTitle: string;
  forms: FormInfo[];
  /** Full-page screenshot as base64 PNG */
  screenshotBase64: string;
}

// ── DOM extraction ─────────────────────────────────────────────────────────────

interface RawField {
  label: string;
  name: string;
  id: string;
  type: string;
  required: boolean;
  placeholder: string;
  selector: string;
  options: string[];
}

interface RawForm {
  formIndex: number;
  action: string;
  method: string;
  submitSelector: string;
  fields: RawField[];
  outerHtml: string;
}

async function extractRawForms(page: Page): Promise<RawForm[]> {
  return page.evaluate(() => {
    function getLabelText(el: Element): string {
      const id = (el as HTMLInputElement).id;
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) return label.textContent?.trim() ?? '';
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent?.trim() ?? '';
      // previous sibling label
      let prev = el.previousElementSibling;
      while (prev) {
        if (prev.tagName === 'LABEL') return prev.textContent?.trim() ?? '';
        prev = prev.previousElementSibling;
      }
      // aria-label attribute
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      return '';
    }

    function isRequired(el: Element, formIndex: number): boolean {
      if ((el as HTMLInputElement).required) return true;
      if (el.getAttribute('aria-required') === 'true') return true;

      // Check label text for asterisk character
      const id = (el as HTMLInputElement).id;
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent?.includes('*')) return true;
      }
      const parentLabel = el.closest('label');
      if (parentLabel?.textContent?.includes('*')) return true;

      // Check nearest container for an asterisk or "required" class
      const container = el.closest('.form-field, .form-group, .field-wrapper, fieldset, p, div');
      if (container) {
        if (container.textContent?.includes('*')) return true;
        if (container.querySelector('[class*="required"], .asterisk, [aria-label*="required"]')) return true;
      }
      return false;
    }

    function buildSelector(el: Element, formIndex: number, fieldIndex: number): string {
      const input = el as HTMLInputElement;
      if (input.id) return `#${CSS.escape(input.id)}`;
      if (input.name) return `[name="${input.name}"]`;
      return `form:nth-of-type(${formIndex + 1}) ${el.tagName.toLowerCase()}:nth-of-type(${fieldIndex + 1})`;
    }

    const seen = new Set<string>();
    const forms = Array.from(document.querySelectorAll('form'));

    return forms.map((form, formIndex) => {
      const allControls = Array.from(
        form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),' +
          'select, textarea',
        ),
      );

      const submitBtn = (
        form.querySelector('button[type="submit"]') ??
        form.querySelector('input[type="submit"]') ??
        form.querySelector('button:not([type="button"]):not([type="reset"])')
      ) as HTMLElement | null;

      let submitSelector = `form:nth-of-type(${formIndex + 1}) [type="submit"]`;
      if (submitBtn) {
        if (submitBtn.id) submitSelector = `#${CSS.escape(submitBtn.id)}`;
        else if (submitBtn.getAttribute('name'))
          submitSelector = `[name="${submitBtn.getAttribute('name')}"]`;
        else
          submitSelector = `form:nth-of-type(${formIndex + 1}) button[type="submit"]`;
      }

      // Deduplicate radio groups — keep only the first radio per name
      const seenRadioNames = new Set<string>();
      const fields: RawField[] = [];

      allControls.forEach((el, i) => {
        const input = el as HTMLInputElement;
        const isRadio = el.tagName === 'INPUT' && input.type === 'radio';
        if (isRadio) {
          if (seenRadioNames.has(input.name)) return;
          seenRadioNames.add(input.name);
        }

        const selector = buildSelector(el, formIndex, i);
        if (seen.has(selector)) return;
        seen.add(selector);

        let options: string[] = [];
        if (el.tagName === 'SELECT') {
          options = Array.from((el as HTMLSelectElement).options)
            .filter((o) => o.value)
            .map((o) => o.value);
        } else if (isRadio) {
          options = Array.from(form.querySelectorAll(`input[type="radio"][name="${input.name}"]`))
            .map((r) => (r as HTMLInputElement).value)
            .filter(Boolean);
        }

        const type =
          el.tagName === 'SELECT'
            ? 'select'
            : el.tagName === 'TEXTAREA'
              ? 'textarea'
              : input.type || 'text';

        fields.push({
          label: getLabelText(el),
          name: input.name,
          id: input.id,
          type,
          required: isRequired(el, formIndex),
          placeholder: input.placeholder ?? '',
          selector,
          options,
        });
      });

      return {
        formIndex,
        action: form.action,
        method: form.method || 'get',
        submitSelector,
        outerHtml: form.outerHTML.slice(0, 8_000),
        fields,
      } as RawForm;
    });
  });
}

// ── Claude CLI interpretation ─────────────────────────────────────────────────

function findClaudePath(): string {
  // Use execFileSync (no shell) to safely locate the binary
  const which = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 5_000 });
  if (!which.error && which.status === 0) return which.stdout.trim();

  for (const p of [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('claude CLI not found. Run: npm install -g @anthropic-ai/claude-code');
}

function interpretWithClaude(rawForms: RawForm[], url: string, pageTitle: string): FormInfo[] {
  const prompt = `You are a QA automation expert. Given raw HTML form data extracted from a web page, you will:
1. Identify each field's purpose from its label, name, id, placeholder, and type.
2. Generate one VALID test value per field that matches real-world data for that field type.
3. Generate 2-3 INVALID test values per field with a short reason each.
   - Always include an empty string ("") as an invalid value for required fields (reason: "required field cannot be empty").
   - For email fields add a malformed email.
   - For phone fields add non-numeric text.
   - For select/radio/checkbox, an invalid value is "" (no selection) if the field is required.
   -Forms should at least have 1 checkbox, with a maximum of 2
4. For checkboxes use a valid value of "true" (checked) and invalid of "" (unchecked if required).
5. Return ONLY a valid JSON array - no markdown fences, no explanation, nothing else.

The JSON must follow this exact schema:
[{"formIndex":0,"action":"","method":"","submitSelector":"","fields":[{"label":"","name":"","id":"","type":"","required":false,"placeholder":"","selector":"","options":[],"testData":{"valid":"","invalid":[{"value":"","reason":""}]}}]}]

Page title: "${pageTitle}"
URL: ${url}

Raw form data:
${JSON.stringify(rawForms, null, 2)}

Return the complete JSON array with testData populated for every field.`;

  const claudePath = findClaudePath();
  console.log(`  [FormScanner] Calling Claude CLI (${claudePath})…`);

  // Write prompt to a temp file and use shell redirection — avoids the stdin/TTY
  // hang that occurs when spawnSync pipes input to claude in a Playwright worker process.
  const tmpFile = path.join(os.tmpdir(), `kh-form-scan-${process.pid}.txt`);
  let text: string;
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    text = execSync(`"${claudePath}" --print < "${tmpFile}"`, {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      shell: '/bin/sh',
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: FormInfo[];
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(
      `Claude returned unparseable JSON.\nError: ${(e as Error).message}\nResponse:\n${text.slice(0, 500)}`,
    );
  }

  return parsed;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans the current page for forms via DOM extraction, then uses the Claude
 * CLI to intelligently interpret each field and generate valid/invalid test
 * data. No API key required — uses the existing Claude Code session.
 *
 * The caller must have already navigated to the target URL (and authenticated
 * for preview environments) before calling this function.
 */
export async function scanForm(page: Page): Promise<FormScanResult> {
  const url = page.url();
  const pageTitle = await page.title();

  console.log(`\n  [FormScanner] Scanning forms on: ${url}`);

  const rawForms = await extractRawForms(page);

  if (rawForms.length === 0) {
    console.warn(`  [FormScanner] No <form> elements found on ${url}`);
  } else {
    const totalFields = rawForms.reduce((s, f) => s + f.fields.length, 0);
    console.log(`  [FormScanner] Found ${rawForms.length} form(s) with ${totalFields} field(s) total`);
  }

  const screenshotBuffer = await page.screenshot({ fullPage: true });
  const screenshotBase64 = screenshotBuffer.toString('base64');

  const forms = rawForms.length > 0
    ? interpretWithClaude(rawForms, url, pageTitle)
    : [];

  console.log(`  [FormScanner] Scan complete.\n`);

  return { url, pageTitle, forms, screenshotBase64 };
}
