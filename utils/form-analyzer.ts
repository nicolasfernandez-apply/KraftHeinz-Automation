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
      // aria-labelledby → concatenate referenced elements' text
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map((refId) => {
          const refEl = document.getElementById(refId);
          return refEl?.textContent?.trim() ?? '';
        }).filter(Boolean);
        if (parts.length) return parts.join(' ');
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

    // NOTE ON SELECTORS: we deliberately use Playwright's chained ">> nth="
    // engine (0-indexed, page-wide) rather than CSS ":nth-of-type". ":nth-of-type"
    // counts siblings *within each element's own parent*, so when a page has two
    // <form> elements under different parents, BOTH are "form:nth-of-type(1)" and
    // "form:nth-of-type(2)" matches nothing. "form >> nth=N" reliably selects the
    // (N+1)-th form on the whole page. `domFormIndex` is that page-wide index.
    function buildSelector(el: Element, domFormIndex: number): string {
      const input = el as HTMLInputElement;
      if (input.id) return `#${CSS.escape(input.id)}`;
      if (input.name) return `[name="${CSS.escape(input.name)}"]`;
      const parentForm = el.closest('form');
      const tag = el.tagName.toLowerCase();
      if (!parentForm) {
        // Orphan element (e.g. file input portalled outside <form>) — use a page-wide nth= selector.
        const pageAll = Array.from(document.querySelectorAll(tag));
        const idx = Math.max(0, pageAll.indexOf(el));
        return `${tag} >> nth=${idx}`;
      }
      const sameTag = Array.from(parentForm.querySelectorAll(tag));
      const idx = Math.max(0, sameTag.indexOf(el));
      return `form >> nth=${domFormIndex} >> css=${tag} >> nth=${idx}`;
    }

    function isSearchForm(form: HTMLFormElement): boolean {
      if (form.getAttribute('role') === 'search') return true;
      const searchTokens = /search|query|autocomplete/i;
      if (searchTokens.test(form.id) || searchTokens.test(form.className)) return true;
      if (searchTokens.test(form.action)) return true;
      // A form whose only inputs are search/text fields named q/s/query/search
      const controls = Array.from(form.querySelectorAll('input, select, textarea'));
      if (controls.length === 0) return false;
      const searchNames = /^(q|s|query|search|keyword|term)$/i;
      return controls.every((el) => {
        const input = el as HTMLInputElement;
        return input.type === 'search' || searchNames.test(input.name ?? '');
      });
    }

    const seen = new Set<string>();
    const allForms = Array.from(document.querySelectorAll('form'));
    const forms = allForms.filter((f) => !isSearchForm(f));

    return forms.map((form, formIndex) => {
      // Page-wide index used for ">> nth=" selectors (survives search-form filtering)
      const domFormIndex = allForms.indexOf(form);
      const allControls = Array.from(
        form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),' +
          'select, textarea',
        ),
      );

      // Custom file-upload widgets often render <input type="file"> outside the
      // <form> tag (e.g. portalled to <body> for stacking-context reasons).
      // On the first non-search form, include any such orphan file inputs so
      // they are still detected, filled, and validated by the test suite.
      if (formIndex === 0) {
        const orphanFileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
          .filter((inp) => !inp.closest('form'));
        for (const inp of orphanFileInputs) {
          allControls.push(inp);
        }
      }

      const submitBtn = (
        form.querySelector('button[type="submit"]') ??
        form.querySelector('input[type="submit"]') ??
        form.querySelector('button:not([type="button"]):not([type="reset"])')
      ) as HTMLElement | null;

      let submitSelector = `form >> nth=${domFormIndex} >> css=[type="submit"]`;
      if (submitBtn) {
        if (submitBtn.id) submitSelector = `#${CSS.escape(submitBtn.id)}`;
        else if (submitBtn.getAttribute('name'))
          submitSelector = `[name="${CSS.escape(submitBtn.getAttribute('name')!)}"]`;
        else if (submitBtn.getAttribute('type') === 'submit')
          submitSelector = `form >> nth=${domFormIndex} >> css=button[type="submit"]`;
        else
          // Last-resort submit button had no id/name/type — target it by its text.
          submitSelector = `form >> nth=${domFormIndex} >> css=button >> text=${(submitBtn.textContent ?? '').trim()}`;
      }

      // Deduplicate radio groups — keep only the first radio per name
      const seenRadioNames = new Set<string>();
      const fields: RawField[] = [];

      allControls.forEach((el) => {
        const input = el as HTMLInputElement;
        const isRadio = el.tagName === 'INPUT' && input.type === 'radio';
        if (isRadio) {
          if (seenRadioNames.has(input.name)) return;
          seenRadioNames.add(input.name);
        }

        const selector = buildSelector(el, domFormIndex);
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

      // ── Custom / ARIA dropdown detection ───────────────────────────────────
      // Modern forms often render dropdowns as:
      //   (a) ARIA combobox/listbox elements, or
      //   (b) plain <button> elements with aria-expanded / aria-haspopup, or
      //   (c) icon-only <button> elements with NO ARIA attributes at all —
      //       identified only by having exclusively image/SVG children and being
      //       inside a labelled form-field container.
      // All three are invisible to the standard querySelectorAll above.

      const comboboxCandidates = Array.from(
        form.querySelectorAll<HTMLElement>(
          '[role="combobox"]:not(input):not(select), ' +
          '[aria-haspopup="listbox"]:not(input):not(select), ' +
          'button[aria-expanded]:not([type="submit"]):not([type="reset"]), ' +
          'button[aria-haspopup]:not([type="submit"]):not([type="reset"]), ' +
          // Icon-only buttons: no ARIA attributes — matched by content heuristic below
          'button:not([type="submit"]):not([type="reset"])',
        ),
      ).filter((el) => {
        // Disabled controls (e.g. a pre-filled, locked "Country" dropdown) can
        // never be interacted with — exclude them regardless of ARIA.
        if ((el as HTMLButtonElement).disabled) return false;

        // For plain <button> elements (no ARIA attributes), include as a
        // potential dropdown trigger when they have at least one img/svg child.
        // This covers both icon-only triggers AND labeled triggers like
        //   <button>Select a state <img …></button>
        if (el.tagName !== 'BUTTON') return true; // keep ARIA-based elements unconditionally
        if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup') || el.hasAttribute('role')) return true;

        const children = Array.from(el.children);
        return children.some(
          (c) =>
            c.tagName === 'IMG' ||
            c.tagName === 'SVG' ||
            c.getAttribute('aria-hidden') === 'true',
        );
      });

      // Pre-compute the index of each combobox button among all non-submit/reset
      // buttons in the form so we can build a reliable Playwright nth= selector.
      const allNonSubmitButtons = Array.from(
        form.querySelectorAll<HTMLElement>('button:not([type="submit"]):not([type="reset"])'),
      );
      const allComboRoles = Array.from(form.querySelectorAll<HTMLElement>('[role="combobox"]'));

      comboboxCandidates.forEach((el) => {
        const btnNth = allNonSubmitButtons.indexOf(el); // 0-based, -1 if not a button

        const selector = el.id
          ? `#${CSS.escape(el.id)}`
          : el.tagName === 'BUTTON' && btnNth >= 0
            // Playwright's page-wide nth= engine gives a unique, reliable match.
            // (CSS :nth-of-type is relative to the parent, so it breaks when the
            // page has multiple <form>s under different parents.)
            ? `form >> nth=${domFormIndex} >> css=button:not([type="submit"]):not([type="reset"]) >> nth=${btnNth}`
            : `form >> nth=${domFormIndex} >> css=[role="combobox"] >> nth=${Math.max(0, allComboRoles.indexOf(el))}`;

        if (seen.has(selector)) return;
        seen.add(selector);

        // Collect options from an associated listbox (via aria-controls, a sibling,
        // or a descendant element with role="listbox" / role="option").
        const controlsId = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
        const listbox = controlsId
          ? document.getElementById(controlsId)
          : (el.querySelector('[role="listbox"]') ??
             el.parentElement?.querySelector('[role="listbox"], ul, [class*="option"]'));

        const options = listbox
          ? Array.from(listbox.querySelectorAll('[role="option"], li'))
              .map((o) => o.textContent?.trim() ?? '')
              .filter(Boolean)
          : [];

        // Resolve the label: check the element, then its parent container.
        // For custom dropdowns where the label is in a sibling <div> (not <label>),
        // also scan the first non-empty text child of the parent container.
        let label = getLabelText(el) || (el.parentElement ? getLabelText(el.parentElement) : '');
        if (!label && el.parentElement) {
          // Pick up "State*" / "How did you first hear…" from a sibling div label
          const firstTextChild = Array.from(el.parentElement.children).find(
            (c) => c !== el && (c.textContent?.trim().length ?? 0) > 0,
          );
          label = firstTextChild?.textContent?.trim() ?? '';
        }

        fields.push({
          label,
          name: el.getAttribute('name') ?? '',
          id: el.id ?? '',
          type: 'combobox',
          required: isRequired(el, formIndex),
          placeholder: el.getAttribute('placeholder') ?? '',
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
   - For select/radio/checkbox/combobox, an invalid value is "" (no selection) if the field is required.
   - Forms should at least have 1 checkbox, with a maximum of 2
   - For dropdown (select or combobox) fields, the valid value must be one of the available option
     texts or values listed in the field's "options" array. Pick a realistic non-empty option.
     Invalid: "" (empty selection if required).
4. For checkboxes use a valid value of "true" (checked) and invalid of "" (unchecked if required).
   For combobox (ARIA custom dropdown) fields, use an exact option text from the "options" array
   as the valid value so the test can match it against the visible option elements.
   For file upload fields (type="file"), use the file "forms.image.jpeg" as the valid value and "" as the
   invalid value (no file selected) if the field is required.
5. Be aware of the following form behaviour that the automated tests rely on:
   - When a required field is left blank and the form is submitted, a validation error message
     appears directly below that field (or within its nearest container). The tests detect this
     message to confirm that validation is working.
   - When the form is submitted with all valid data, a success or confirmation message is shown
     on the page (or the user is redirected). The tests look for this to confirm the submission
     succeeded. Make sure the valid test values you generate are realistic enough to actually
     pass any server-side validation (e.g. use a real-looking email, not "test@test.com").
6. Return ONLY a valid JSON array - no markdown fences, no explanation, nothing else.

The JSON must follow this exact schema:
[{"formIndex":0,"action":"","method":"","submitSelector":"","fields":[{"label":"","name":"","id":"","type":"","required":false,"placeholder":"","selector":"","options":[],"testData":{"valid":"","invalid":[{"value":"","reason":""}]}}]}]

Page title: "${pageTitle}"
URL: ${url}

Raw form data:
${JSON.stringify(rawForms, null, 2)}

Return the complete JSON array with testData populated for every field.`;

  const claudePath = findClaudePath();
  console.log(`  [FormScanner] Calling Claude CLI (${claudePath})…`);

  const MAX_ATTEMPTS = 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.warn(`  [FormScanner] Retrying Claude call (attempt ${attempt}/${MAX_ATTEMPTS})…`);
    }

    // Write prompt to a temp file and use shell redirection — avoids the stdin/TTY
    // hang that occurs when spawnSync pipes input to claude in a Playwright worker process.
    const tmpFile = path.join(os.tmpdir(), `kh-form-scan-${process.pid}-${attempt}.txt`);
    let text: string;
    try {
      fs.writeFileSync(tmpFile, prompt, 'utf8');
      text = execSync(`"${claudePath}" --print < "${tmpFile}"`, {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
        shell: '/bin/sh',
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    try {
      return JSON.parse(clean) as FormInfo[];
    } catch (e) {
      lastError = new Error(
        `Claude returned unparseable JSON (attempt ${attempt}/${MAX_ATTEMPTS}).\nError: ${(e as Error).message}\nResponse:\n${text.slice(0, 500)}`,
      );
      console.warn(`  [FormScanner] ${lastError.message}`);
    }
  }

  throw lastError;
}

/**
 * Normalises checkbox requiredness to match the known KraftHeinz form behaviour:
 *   • A form with a SINGLE checkbox → that checkbox is always required
 *     (e.g. the mandatory terms/consent acceptance).
 *   • A form with TWO checkboxes → exactly one is required and one is optional
 *     (e.g. required consent + optional marketing opt-in). When field detection
 *     is ambiguous (both marked required, or both optional) we keep the first as
 *     required and force the second to optional so the "mandatory only" valid
 *     scenario has a well-defined target.
 * DOM-detected requiredness is trusted when it already produces exactly one
 * required checkbox out of two.
 */
function normalizeCheckboxRequiredness(forms: FormInfo[]): void {
  for (const form of forms) {
    const checkboxes = form.fields.filter((f) => f.type === 'checkbox');

    if (checkboxes.length === 1) {
      checkboxes[0].required = true;
      continue;
    }

    if (checkboxes.length === 2) {
      const requiredCount = checkboxes.filter((c) => c.required).length;
      if (requiredCount !== 1) {
        // Ambiguous detection — pin the first as mandatory, the second as optional.
        checkboxes[0].required = true;
        checkboxes[1].required = false;
      }
    }
  }
}

export function isEmailField(field: FormField): boolean {
  if (field.type === 'email') return true;
  const emailPattern = /email/i;
  return emailPattern.test(field.label) || emailPattern.test(field.name) || emailPattern.test(field.id);
}

const EMAIL_COUNTER_PATH = path.join(__dirname, '..', '.email-counter');

function nextEmailCounter(): number {
  let counter = 0;
  try {
    counter = parseInt(fs.readFileSync(EMAIL_COUNTER_PATH, 'utf8').trim(), 10) || 0;
  } catch { /* file doesn't exist yet — start at 0 */ }
  fs.writeFileSync(EMAIL_COUNTER_PATH, String(counter + 1), 'utf8');
  return counter;
}

/**
 * Generates a unique email address for a form submission.
 * Called once per actual submission so every test scenario gets a distinct address.
 */
export function generateUniqueEmail(formName: string): string {
  const slug = formName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const n = nextEmailCounter();
  return `${slug}${ts}${n}@applydigital.com`;
}

function applyUniqueEmailAddresses(forms: FormInfo[], formName: string, _scenarioNumber: number): void {
  const slug = formName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  for (const form of forms) {
    for (const field of form.fields) {
      if (isEmailField(field)) {
        const n = nextEmailCounter();
        // Rewrite non-empty invalid values to an identifiable-but-invalid format
        // (no @ means it's still rejected by email validation, but traceable if it slips through)
        for (const inv of field.testData.invalid) {
          if (inv.value !== '') {
            inv.value = `${slug}${ts}${n}`;
          }
        }
      }
    }
  }
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
export async function scanForm(page: Page, formName: string, scenarioNumber: number): Promise<FormScanResult> {
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

  // Dynamic option discovery: for combobox fields whose options couldn't be
  // read from the static DOM (e.g. the listbox only appears after clicking),
  // temporarily click the trigger, capture the revealed options, then close.
  // Some custom multiselects keep the panel open after interaction (Escape does
  // not close them), so we toggle the trigger again to close and prevent the
  // open panel from overlapping — and intercepting clicks on — the next field.
  for (const rawForm of rawForms) {
    for (const field of rawForm.fields) {
      if (field.type !== 'combobox' || field.options.length > 0) continue;
      try {
        const loc = page.locator(field.selector).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
        const isOpen = async () => (await loc.getAttribute('aria-expanded').catch(() => null)) === 'true';
        if (!(await isOpen())) await loc.click({ timeout: 3_000 });
        await page.waitForTimeout(500);
        const opts = await page
          .locator('[role="option"], [role="listbox"] li, [class*="option"]:visible, [class*="dropdown"]:visible li')
          .allInnerTexts()
          .catch(() => [] as string[]);
        field.options = opts.map((t) => t.trim()).filter(Boolean);
        if (field.options.length > 0) {
          console.log(`  [FormScanner] Discovered ${field.options.length} options for "${field.label}" via click`);
        }
        // Close: toggle the trigger if still open, then Escape as a backstop.
        if (await isOpen()) await loc.click({ timeout: 3_000 }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      } catch {
        // Non-fatal — leave options empty; Claude will infer a plausible value
      }
    }
  }

  const screenshotBuffer = await page.screenshot({ fullPage: true });
  const screenshotBase64 = screenshotBuffer.toString('base64');

  const forms = rawForms.length > 0
    ? interpretWithClaude(rawForms, url, pageTitle)
    : [];

  normalizeCheckboxRequiredness(forms);
  applyUniqueEmailAddresses(forms, formName, scenarioNumber);

  console.log(`  [FormScanner] Scan complete.\n`);

  return { url, pageTitle, forms, screenshotBase64 };
}
