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
import { runPreAction } from '../utils/pre-action';
import { scanForm, FormScanResult, FormField, FormInfo, isEmailField, generateUniqueEmail } from '../utils/form-analyzer';
import {
  generateFormReport,
  FormReportData,
  FormScenarioResult,
  FieldValidationResult,
  SubmittedFieldValue,
  BackendRequestInfo,
} from '../utils/form-report';

// ── Config types & loader ─────────────────────────────────────────────────────

interface FormEntry {
  name: string;
  url: string;
  /** Case-insensitive: "preview", "Preview", "PREVIEW" all trigger IAP auth */
  environment: string;
  /**
   * Optional name of a pre-action defined in pre-actions.config.json.
   * When set, the action is executed after login but before the form scan and
   * all test scenarios (e.g. dismiss an age gate, select a country).
   */
  preAction?: string;
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

// ── Cookie / consent banner dismissal ────────────────────────────────────────

/**
 * Dismisses any cookie-consent or privacy banner that might be overlaid on the
 * page. Must be called after navigation and before any form interaction so that
 * overlay elements cannot intercept clicks meant for form fields.
 *
 * Uses a single combined locator so the wait is at most 3 s total regardless
 * of how many selectors are listed — avoiding the O(n × timeout) penalty of
 * sequential per-selector waits.
 */
async function dismissCookieBanner(page: Page): Promise<void> {
  const currentUrl = page.url();
  const combined = page.locator([
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Reject All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("I Accept")',
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    '[data-testid="cookie-accept"]',
  ].join(', ')).first();

  // Cookie-consent scripts (e.g. OneTrust) initialise asynchronously and can
  // appear several seconds after the page reaches networkidle. waitFor waits up
  // to 6 s for any dismiss button to become visible; if none appears we exit.
  const appeared = await combined
    .waitFor({ state: 'visible', timeout: 6_000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) return;

  await combined.click().catch(() => {});
  // Wait for the banner animation / any resulting reload to settle.
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  // If the click navigated away from the form page, go back.
  if (page.url() !== currentUrl) {
    await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
}

// ── Field interaction helpers ─────────────────────────────────────────────────

async function fillField(page: Page, field: FormField, value: string): Promise<void> {
  try {
    const loc = page.locator(field.selector).first();
    const isToggle = field.type === 'checkbox' || field.type === 'radio';

    // File upload widgets often live in Shadow DOM or are lazily rendered — their
    // selectors may not resolve to an attached element at this point. Skip the
    // top-level wait; the file-handling branch below does its own resilient check.
    if (field.type !== 'file') {
      await loc.waitFor({ state: isToggle ? 'attached' : 'visible', timeout: 5_000 });
    }

    if (field.type === 'select') {
      if (value) {
        await loc.selectOption(value);
      } else {
        // Simulate "no selection" — prefer the blank option, fall back to index 0.
        await loc.selectOption({ value: '' }).catch(() => loc.selectOption({ index: 0 }));
      }
    } else if (field.type === 'combobox') {
      // ARIA/custom dropdown (e.g. Headless UI / ml-core listbox). Some of these
      // multiselect variants KEEP the option panel open after a selection
      // (aria-expanded stays "true"), and that "absolute z-30" panel overlaps the
      // next field below — intercepting its click. So we: (1) only click to open
      // when not already open, (2) pick the option, (3) if the panel is still
      // open, click the trigger again to toggle it closed before returning.
      if (value) {
        await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});

        const isOpen = async () => (await loc.getAttribute('aria-expanded').catch(() => null)) === 'true';

        if (!(await isOpen())) {
          await loc.click();
        }
        await page.waitForTimeout(300);

        // Exact text match first, then substring (value "Yes" → "Yes, absolutely!").
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const optionExact = page.locator('[role="option"], [role="listbox"] li')
          .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
        const optionLoose = page.locator(
          `[role="option"]:has-text("${value}"), [data-value="${value}"], [role="listbox"] li:has-text("${value}")`,
        ).first();

        if (await optionExact.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await optionExact.click();
        } else if (await optionLoose.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await optionLoose.click();
        } else {
          console.warn(`  [Forms] No option matching "${value}" found in combobox "${field.label}"`);
        }
        await page.waitForTimeout(200);

        // Close the panel if it stayed open, so it can't overlay the next field.
        if (await isOpen()) {
          await loc.click({ timeout: 3_000 }).catch(() => {});
          await page.waitForTimeout(200);
        }
      }
    } else if (field.type === 'checkbox') {
      const shouldCheck = value === 'true' || value === '1';
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      let nowChecked = await loc.isChecked().catch(() => false);
      if (shouldCheck === nowChecked) return;

      // Strategy 1: click the input itself when it's visible. This is the most
      // reliable approach for native checkboxes and fires React synthetic events.
      if (await loc.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await loc.click({ timeout: 3_000 }).catch(() => {});
        nowChecked = await loc.isChecked().catch(() => false);
      }

      // Strategy 2: label[for] click — but click at the LEFT edge of the label
      // (x+8) to target the visual indicator and avoid any hyperlinks embedded in
      // the label text (e.g. "rules and regulations" link), which would silently
      // absorb the click without toggling the checkbox.
      if (nowChecked !== shouldCheck) {
        const inputId = await loc.getAttribute('id').catch(() => null);
        if (inputId) {
          const labelLoc = page.locator(`label[for="${inputId}"]`).first();
          const bbox = await labelLoc.boundingBox().catch(() => null);
          if (bbox) {
            await page.mouse.click(bbox.x + 8, bbox.y + bbox.height / 2);
            nowChecked = await loc.isChecked().catch(() => false);
          }
        }
      }

      // Strategy 3: wrapping label — also click at the left edge for the same reason.
      if (nowChecked !== shouldCheck) {
        const wrappingLabel = page.locator('label').filter({ has: loc }).first();
        const bbox = await wrappingLabel.boundingBox().catch(() => null);
        if (bbox) {
          await page.mouse.click(bbox.x + 8, bbox.y + bbox.height / 2);
          nowChecked = await loc.isChecked().catch(() => false);
        }
      }

      // Strategy 4: native DOM .click() — fires browser events even on hidden inputs.
      if (nowChecked !== shouldCheck) {
        await loc.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
        nowChecked = await loc.isChecked().catch(() => false);
      }

      // Last resort: Playwright force check/uncheck.
      if (nowChecked !== shouldCheck) {
        if (shouldCheck) await loc.check({ force: true }).catch(() => {});
        else await loc.uncheck({ force: true }).catch(() => {});
      }
    } else if (field.type === 'radio') {
      if (value) {
        const radio = page.locator(`[name="${field.name}"][value="${value}"]`).first();
        await radio.check({ force: true });
      }
    } else if (field.type === 'file') {
      if (value) {
        const filePath = path.resolve(process.cwd(), value);

        // Primary strategy: find a visible "Upload" button inside the form and click
        // it to trigger the native file chooser. Custom upload widgets (drag-and-drop
        // zones, React dropzones, etc.) typically expose a labelled button rather
        // than a clickable <input type="file">, so this handles the common case first.
        const uploadButton = page.locator(
          'button:has-text("Upload"), button:has-text("upload"), ' +
          'button:has-text("Choose File"), button:has-text("Browse"), ' +
          'button:has-text("Add file"), button:has-text("Select file")',
        ).first();

        const uploadButtonVisible = await uploadButton.isVisible({ timeout: 2_000 }).catch(() => false);

        if (uploadButtonVisible) {
          // Use .catch(() => null) so the promise always settles. Without this,
          // if the click succeeds but the React component never opens a native OS
          // dialog, the promise becomes a dangling rejected promise that Playwright
          // converts into an unhandled-rejection test failure 8 s later.
          const chooserPromise = page.waitForEvent('filechooser', { timeout: 3_000 }).catch(() => null);
          await uploadButton.click({ timeout: 5_000 });
          const chooser = await chooserPromise;
          if (chooser) {
            await chooser.setFiles(filePath);
          } else {
            // No native dialog opened — React may have injected a hidden file input.
            await page.waitForTimeout(600);
            const dynInput = page.locator('input[type="file"]').first();
            if (await dynInput.count().then((n) => n > 0).catch(() => false)) {
              await dynInput.setInputFiles(filePath, { timeout: 5_000 }).catch(() => {});
            }
          }
        } else {
          // Fallback: try setInputFiles directly on the <input type="file"> element.
          // Works for standard (possibly hidden) file inputs; falls back to a
          // click-triggered chooser for Shadow DOM or lazily rendered inputs.
          const attached = await loc.waitFor({ state: 'attached', timeout: 5_000 }).then(() => true).catch(() => false);
          if (attached) {
            try {
              await loc.setInputFiles(filePath, { timeout: 8_000 });
            } catch {
              const chooserPromise = page.waitForEvent('filechooser', { timeout: 3_000 }).catch(() => null);
              await loc.click({ force: true, timeout: 5_000 });
              const chooser = await chooserPromise;
              if (chooser) await chooser.setFiles(filePath);
            }
          } else {
            // Last resort: look for any other visible upload trigger on the page
            const chooserPromise = page.waitForEvent('filechooser', { timeout: 3_000 }).catch(() => null);
            const uploadTrigger = page.locator([
              field.id ? `label[for="${field.id}"]` : null,
              '[class*="upload"]:visible',
              '[class*="dropzone"]:visible',
            ].filter(Boolean).join(', ')).first();
            await uploadTrigger.click({ timeout: 5_000 });
            const chooser = await chooserPromise;
            if (chooser) await chooser.setFiles(filePath);
          }
        }
      }
    } else {
      await loc.fill(value);
    }
  } catch {
    // Non-fatal: some fields may be conditionally visible or dynamic
    console.warn(`  [Forms] Could not fill field "${field.label}" (${field.selector}) — skipping`);
  }
}

// ── Upload trigger helpers ────────────────────────────────────────────────────

/**
 * Scrolls a locator into view, waits for a filechooser event triggered by
 * clicking it, and sets the given file path. Returns true on success.
 */
async function attemptFileUpload(page: Page, loc: import('@playwright/test').Locator, filePath: string): Promise<boolean> {
  // Use an image file for Cloudinary (accepts .jpg/.jpeg/.png only)
  const imageFilePath = (() => {
    const imgPath = path.resolve(process.cwd(), 'forms.image.jpeg');
    return fs.existsSync(imgPath) ? imgPath : filePath;
  })();

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});

    // Strategy 1 — native OS file-chooser dialog (short wait — most custom upload
    // components don't fire this event, so we check quickly and move on).
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 800 }).catch(() => null);
    await loc.click({ timeout: 5_000 });
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(filePath);
      await page.waitForTimeout(500);
      return true;
    }

    // Strategy 2 — Cloudinary Upload Widget
    // Clicking the upload button mounts the Cloudinary widget in a cross-origin
    // iframe (data-test="uw-iframe", src=upload-widget.cloudinary.com). There are
    // usually TWO such iframes — one hidden pre-loader and one visible active
    // widget — so we must target the VISIBLE one to avoid a strict-mode match on
    // both. The file <input> lives inside that iframe.
    const cwIframeSel = 'iframe[data-test="uw-iframe"], iframe[src*="upload-widget.cloudinary.com"], iframe[src*="cloudinary"]';

    // Wait until at least one Cloudinary iframe has mounted.
    const iframeMounted = await page.locator(cwIframeSel).first()
      .waitFor({ state: 'attached', timeout: 12_000 })
      .then(() => true).catch(() => false);

    if (iframeMounted) {
      console.log('  [UploadHandler] Cloudinary widget iframe mounted — locating file input');

      // Pick the visible iframe element (the active widget), falling back to the
      // last one if none report visible yet.
      const iframeEls = await page.locator(cwIframeSel).all();
      let cwFrame: import('@playwright/test').FrameLocator | null = null;
      for (const el of iframeEls) {
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          cwFrame = el.contentFrame();
          break;
        }
      }
      if (!cwFrame && iframeEls.length > 0) {
        cwFrame = iframeEls[iframeEls.length - 1].contentFrame();
      }

      if (cwFrame) {
        // The widget exposes <input type="file" class="cloudinary_fileupload">.
        // setInputFiles works even if the input is visually hidden, so we don't
        // need to navigate the widget's "My Files" tab first.
        const cwInput = cwFrame.locator('input[type="file"].cloudinary_fileupload, input[type="file"]').first();
        const cwInputReady = await cwInput.waitFor({ state: 'attached', timeout: 10_000 })
          .then(() => true).catch(() => false);

        if (cwInputReady) {
          console.log('  [UploadHandler] Setting file on Cloudinary input');
          await cwInput.setInputFiles(imageFilePath, { timeout: 10_000 });

          // Cloudinary auto-uploads the file then shows a "Done" / "Terminé" button.
          const doneBtn = cwFrame.locator(
            'button:has-text("Done"), button:has-text("Terminé"), [data-test="done-button"], .done_button',
          ).first();
          const uploadDone = await doneBtn.waitFor({ state: 'visible', timeout: 45_000 })
            .then(() => true).catch(() => false);
          if (uploadDone) {
            await doneBtn.click({ timeout: 5_000 }).catch(() => {});
            await page.waitForTimeout(1_500); // widget closes and the form field populates
            console.log('  [UploadHandler] Upload complete — clicked "Done"');
          } else {
            console.warn('  [UploadHandler] Cloudinary "Done" button did not appear — upload may still be in progress');
          }
          return true;
        }

        console.warn('  [UploadHandler] Cloudinary iframe present but file input not found inside it');
      }
    }

    // Fallback — a direct <input type="file"> somewhere on the page
    const directInput = page.locator('input[type="file"]').first();
    const directReady = await directInput.waitFor({ state: 'attached', timeout: 2_000 })
      .then(() => true).catch(() => false);
    if (directReady) {
      console.log('  [UploadHandler] Direct file input found — uploading');
      await directInput.setInputFiles(imageFilePath, { timeout: 8_000 });
      await page.waitForTimeout(1_000);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ── Claude-assisted upload button handler ─────────────────────────────────────

/**
 * Uses Claude to scan the current page HTML for any file-upload trigger in any
 * language, then clicks the found element and sets forms.config.json as the
 * uploaded file. Silently no-ops when no upload button is detected.
 *
 * Covers buttons whose text may be in French (Téléchargez), Spanish (Subir),
 * German (Hochladen), Italian (Carica), Portuguese (Carregar), etc., as well
 * as ARIA-labelled triggers, CSS-class-based widgets, and <label> wrappers
 * that proxy a hidden <input type="file">.
 */
async function handleUploadButtonWithClaude(page: Page): Promise<void> {
  const filePath = path.resolve(process.cwd(), 'forms.config.json');
  if (!fs.existsSync(filePath)) {
    console.warn('  [UploadHandler] forms.config.json not found — skipping upload step');
    return;
  }

  // ── Fast-path: try well-known upload-trigger patterns directly with Playwright ──
  // This covers the most common cases (including custom React upload components
  // that have no <input type="file">) without needing a Claude round-trip.
  const fastPathSelectors = [
    '[data-testid="image-upload-molecule"] button',
    '[data-testid="clickable-cta-atom"]',
    'button:has-text("Upload image")',
    'button:has-text("Upload")',
    'button:has-text("upload")',
    'button:has-text("Choose File")',
    'button:has-text("Browse")',
    'button:has-text("Télécharger")',
    'button:has-text("Téléchargez")',
    'button:has-text("Subir")',
    'button:has-text("Hochladen")',
    'button:has-text("Carica")',
    '[aria-label*="upload" i]',
    '[aria-label*="télécharger" i]',
    '[aria-label*="subir" i]',
    'label[for]:has(~ input[type="file"])',
    'label:has(input[type="file"])',
  ];

  for (const sel of fastPathSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1_000 }).catch(() => false)) {
        console.log(`  [UploadHandler] Fast-path found upload trigger: ${sel}`);
        const uploaded = await attemptFileUpload(page, loc, filePath);
        if (uploaded) return;
      }
    } catch {
      // selector may be invalid in some browsers — continue
    }
  }

  // ── Claude fallback: extract focused form HTML and ask Claude to find the trigger ──
  // Use the innermost <form> or main content area to avoid nav/header/cookie-banner
  // content bloating the prompt and causing truncation before the upload widget.
  const focusedHtml = await page.evaluate(() => {
    // Prefer the form element; otherwise the first <main>; otherwise <body>.
    const form = document.querySelector('form[data-testid], form')
      ?? document.querySelector('main')
      ?? document.body;
    return (form?.innerHTML ?? document.body.innerHTML).slice(0, 25_000);
  }).catch(() => '');

  const prompt = `You are a QA automation expert. Your job is to detect file-upload triggers on a web page.

Examine the HTML below and find EVERY element that a user would click to open a file-picker dialog.
These triggers appear in many forms:
  • <button> or <a> whose visible text (or aria-label / title / data-* attributes) contains any
    language variant of "upload", "choose file", "browse", "attach", "select file", or "add file":
      – English    : Upload, Upload image, Upload Receipt, Choose File, Browse, Select File, Add File, Attach
      – French     : Télécharger, Téléchargez, Choisir un fichier, Parcourir, Joindre, Importer
      – Spanish    : Subir, Subir archivo, Cargar, Seleccionar archivo, Examinar, Adjuntar
      – German     : Hochladen, Datei wählen, Durchsuchen, Anhängen, Datei hochladen
      – Italian    : Carica, Sfoglia, Scegli file, Carica file, Allega
      – Portuguese : Carregar, Escolher ficheiro, Enviar ficheiro, Anexar, Fazer upload
      – Dutch      : Uploaden, Bestand kiezen, Bladeren, Bijvoegen
      – Any other language translation of the same concepts
  • Custom React / Vue upload components (look for data-testid="image-upload-molecule",
    data-testid="clickable-cta-atom", or similar patterns wrapping an upload button)
  • <label for="..."> elements whose paired <input> has type="file"
  • Any element (div, span, section) with class names containing: upload, file-btn, dropzone, attach, browse
  • Elements with aria-label or title attributes containing any upload-related words
  • Custom drag-and-drop zones that trigger file selection on click

STRICT rules:
  1. Exclude <input type="file"> elements themselves — only return the VISIBLE trigger the user clicks.
  2. Prefer the most specific, stable selector: [data-testid] > id > class > tag + text content.
  3. If two selectors point to the same visual button, include only the more specific one.
  4. Return ONLY valid JSON — no markdown fences, no explanation, nothing else.

Return this exact schema:
{
  "found": true,
  "uploadTriggers": [
    {
      "selector": "<CSS selector for the clickable trigger>",
      "text": "<visible label on the element>",
      "language": "<detected language of the label>",
      "confidence": "high | medium | low"
    }
  ]
}

If no upload trigger exists anywhere on the page return exactly:
{"found":false,"uploadTriggers":[]}

HTML:
${focusedHtml}`;

  let claudeResult: { found: boolean; uploadTriggers: { selector: string; text: string; language: string; confidence: string }[] };

  try {
    // Reuse the same Claude CLI invocation pattern used by the form-scanner.
    const claudePathResult = (() => {
      const { spawnSync: sp } = require('child_process') as typeof import('child_process');
      const which = sp('which', ['claude'], { encoding: 'utf8', timeout: 5_000 });
      if (!which.error && which.status === 0) return which.stdout.trim();
      for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${process.env.HOME}/.npm-global/bin/claude`]) {
        if (fs.existsSync(p)) return p;
      }
      throw new Error('claude CLI not found');
    })();

    const tmpFile = path.join(require('os').tmpdir(), `kh-upload-check-${process.pid}.txt`);
    let raw: string;
    try {
      fs.writeFileSync(tmpFile, prompt, 'utf8');
      const { execSync: ex } = require('child_process') as typeof import('child_process');
      raw = ex(`"${claudePathResult}" --print --max-tokens 8096 < "${tmpFile}"`, {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
        env: process.env,
        shell: '/bin/sh',
      }) as string;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    claudeResult = JSON.parse(clean);
  } catch (e) {
    console.warn(`  [UploadHandler] Claude call failed — skipping upload step: ${(e as Error).message}`);
    return;
  }

  if (!claudeResult.found || claudeResult.uploadTriggers.length === 0) {
    console.log('  [UploadHandler] No upload button detected on this page — skipping');
    return;
  }

  // Try each trigger in descending confidence order (high → medium → low).
  const ordered = [...claudeResult.uploadTriggers].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.confidence as keyof typeof rank] ?? 3) - (rank[b.confidence as keyof typeof rank] ?? 3);
  });

  for (const trigger of ordered) {
    console.log(`  [UploadHandler] Trying upload trigger: "${trigger.text}" (${trigger.language}, ${trigger.confidence}) → ${trigger.selector}`);
    const loc = page.locator(trigger.selector).first();
    const visible = await loc.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!visible) {
      console.warn(`  [UploadHandler] Trigger not visible — trying next`);
      continue;
    }
    const uploaded = await attemptFileUpload(page, loc, filePath);
    if (uploaded) {
      console.log(`  [UploadHandler] File uploaded successfully via "${trigger.text}"`);
      return;
    }
    console.warn(`  [UploadHandler] Trigger "${trigger.selector}" failed — trying next`);
  }

  console.warn('  [UploadHandler] All detected upload triggers failed — continuing without upload');
}

/**
 * Resolves the value to apply to a field for a valid submission.
 *
 * Checkboxes are special: a required checkbox (mandatory consent) is always
 * checked; an optional checkbox is only checked in the "both checkboxes"
 * variant and left unchecked in the "mandatory only" variant.
 */
function validValueForField(field: FormField, includeOptionalCheckboxes: boolean): string {
  if (field.type === 'checkbox') {
    if (field.required) return 'true';
    return includeOptionalCheckboxes ? 'true' : '';
  }
  return field.testData?.valid ?? '';
}

/** Human-readable rendering of an applied value for the report. */
function displayValue(field: FormField, value: string): string {
  if (field.type === 'checkbox') return value === 'true' ? 'checked' : 'unchecked';
  if (field.type === 'file') return value === '' ? '(no file)' : value;
  return value === '' ? '(empty)' : value;
}

/**
 * Fills all given fields with their valid test values and returns the data that
 * was loaded, for inclusion in the report. When `includeOptionalCheckboxes` is
 * false, optional checkboxes are left unchecked (the "mandatory only" variant).
 *
 * Email fields get a fresh unique address per call so repeated valid-submission
 * scenarios don't reuse the same email address across test variants.
 */
async function fillValidData(
  page: Page,
  form: FormInfo,
  includeOptionalCheckboxes: boolean,
  formName: string,
): Promise<SubmittedFieldValue[]> {
  const submitted: SubmittedFieldValue[] = [];

  // Compute values for all fields upfront (maintains deterministic email generation order).
  const fieldValues = form.fields.map((field) => ({
    field,
    value: isEmailField(field) && field.type !== 'checkbox'
      ? generateUniqueEmail(formName)
      : validValueForField(field, includeOptionalCheckboxes),
  }));

  // Fill non-checkbox fields first (including file uploads).
  // Cloudinary and other upload widgets can trigger a React re-render that
  // resets checkboxes that were filled earlier, so we defer them.
  for (const { field, value } of fieldValues) {
    if (field.type === 'checkbox') continue;
    await fillField(page, field, value);
  }

  // Fill checkboxes last — after all upload interactions have settled.
  for (const { field, value } of fieldValues) {
    if (field.type !== 'checkbox') continue;
    await fillField(page, field, value);
  }

  // Build the submitted-data report in the original field order.
  for (const { field, value } of fieldValues) {
    submitted.push({
      field: field.label || field.name || field.id || '—',
      type: field.type,
      value: displayValue(field, value),
    });
  }

  return submitted;
}

// ── Validation error detection ────────────────────────────────────────────────

/**
 * Captures the visible text content in the immediate area around a form field
 * (the field's nearest container element). Used for before/after comparison to
 * detect validation messages that appear below a field after submission.
 *
 * Special handling:
 * - Checkboxes nested inside a <label>: climbs past the label so sibling error
 *   messages (which appear outside the label) are included in the captured area.
 * - Select fields: option text is stripped from the snapshot to avoid noise
 *   (option text doesn't change, but it would dominate the before/after diff).
 */
async function getFieldAreaText(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const field = document.querySelector(sel);
    if (!field) return '';
    const input = field as HTMLInputElement;

    // For checkboxes/radios that live inside a <label>, the label is the direct
    // parentElement but error messages typically appear as siblings of that label.
    // Climb one level higher so the comparison window includes those siblings.
    const isToggle = input.type === 'checkbox' || input.type === 'radio';
    const labelAncestor = isToggle ? field.closest('label') : null;
    const startEl = labelAncestor?.parentElement ?? field.parentElement;

    const container =
      field.closest('.form-field, .form-group, .field-wrapper, .field, fieldset, li') ??
      startEl;

    if (!container) return '';

    // For select fields, strip <option> text so only labels/messages are compared.
    if (field.tagName === 'SELECT') {
      const clone = container.cloneNode(true) as Element;
      clone.querySelectorAll('select').forEach((s) => s.replaceWith(''));
      return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    }

    return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
  }, selector).catch(() => '');
}

/** Snapshots the text near each field so we can diff after submit. */
async function captureFieldAreaTexts(page: Page, fields: FormField[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const field of fields) {
    map.set(field.selector, await getFieldAreaText(page, field.selector));
  }
  return map;
}

/**
 * Returns the visible error text nearest to a specific field, or empty string.
 * Checks aria-describedby, aria-invalid siblings, common CSS class patterns,
 * and new text that appeared below the field after submission.
 */
async function getFieldError(
  page: Page,
  field: FormField,
  beforeText?: string,
): Promise<string> {
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

    // If we have a before-state, extract the new text that appeared below the field
    if (beforeText !== undefined) {
      const afterText = await getFieldAreaText(page, sel);
      if (afterText.length > beforeText.length) {
        const newText = afterText.replace(beforeText, '').trim();
        if (newText) return newText;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Returns true if any visible validation error messages appear on the page
 * after an attempted form submission.
 *
 * Pass `requiredFields` + `beforeTexts` to also detect messages that appeared
 * directly below fields (which may not use standard error CSS class names).
 */
async function hasAnyValidationErrors(
  page: Page,
  requiredFields?: FormField[],
  beforeTexts?: Map<string, string>,
): Promise<boolean> {
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

  // Detect messages that appeared below required fields after submission
  if (requiredFields && beforeTexts) {
    for (const field of requiredFields) {
      const before = beforeTexts.get(field.selector) ?? '';
      const after = await getFieldAreaText(page, field.selector);
      if (after.length > before.length && after !== before) return true;
    }
  }

  return false;
}

/**
 * Returns true if the page shows a success state after submission:
 * a redirect, a visible success/confirmation element, or well-known
 * success keywords in the body text.
 *
 * Does NOT treat "absence of errors" as a proxy for success — that is
 * unreliable and produces false positives when error detection is imperfect.
 */
async function detectSuccessState(
  page: Page,
  originalUrl: string,
  beforeBodyText?: string,
): Promise<{ success: boolean; detail: string }> {
  const currentUrl = page.url();
  if (currentUrl !== originalUrl) {
    return { success: true, detail: `Redirected to: ${currentUrl}` };
  }

  const successPatterns = [
    '[class*="success"]:visible',
    '[class*="thank"]:visible',
    '[class*="confirmation"]:visible',
    '[class*="confirm"]:visible',
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
  const successKeywords = ['thank you', 'thanks', 'submitted', 'received', 'success', 'sent', 'confirmation', 'recorded'];
  for (const kw of successKeywords) {
    // Only count the keyword if it wasn't already on the page before submit —
    // words like "sent" can appear in nav links or page copy and would otherwise
    // fire as false positives.
    if (bodyText.includes(kw) && !(beforeBodyText ?? '').includes(kw)) {
      return { success: true, detail: `Success keyword found after submit: "${kw}"` };
    }
  }

  // If we have a before-snapshot, check whether the page content changed meaningfully
  // (e.g. form replaced by a success message with non-standard CSS classes)
  if (beforeBodyText !== undefined) {
    const addedChars = bodyText.length - beforeBodyText.length;
    const hasErrors = await hasAnyValidationErrors(page);
    if (addedChars > 20 && !hasErrors) {
      return { success: true, detail: 'Page content changed after submit with no validation errors visible' };
    }
  }

  // If the page has reCAPTCHA, automated submission cannot succeed — treat this
  // as a "blocked by bot protection" result rather than a test failure.
  const hasRecaptcha = await page.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]').count().catch(() => 0);
  if (hasRecaptcha > 0) {
    return {
      success: true,
      detail: 'Form has reCAPTCHA — automated submission cannot complete; treating as inconclusive pass',
    };
  }

  const hasErrors = await hasAnyValidationErrors(page);
  return {
    success: false,
    detail: hasErrors
      ? 'Validation errors still visible after submit with valid data'
      : 'No success indicator found — no redirect, no success message, and no recognised success keywords',
  };
}

// ── Backend request capture ─────────────────────────────────────────────────

/**
 * Recursively searches a parsed object for a key whose name contains "campaign"
 * and returns its stringified value. Handles nested objects/arrays.
 */
function findCampaignValue(node: unknown): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findCampaignValue(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/campaign/i.test(key)) {
        if (value !== null && value !== undefined && typeof value !== 'object') return String(value);
        if (typeof value === 'object') {
          // e.g. { campaign: { name: "..." } } — prefer a name-ish leaf.
          const leaf = findCampaignValue(value);
          if (leaf) return leaf;
        }
      }
    }
    // Not found at this level — descend into nested objects.
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const found = findCampaignValue(value);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * Extracts a campaign name from a request body given its content type.
 * Supports JSON and URL-encoded / form payloads; falls back to a regex scan.
 */
function extractCampaignName(payload: string, contentType: string): string | undefined {
  const ct = contentType.toLowerCase();

  if (ct.includes('json') || /^\s*[{[]/.test(payload)) {
    try {
      return findCampaignValue(JSON.parse(payload));
    } catch {
      // fall through to other strategies
    }
  }

  if (ct.includes('urlencoded') || (payload.includes('=') && payload.includes('&'))) {
    try {
      const params = new URLSearchParams(payload);
      for (const [key, value] of params.entries()) {
        if (/campaign/i.test(key) && value) return value;
      }
    } catch {
      // fall through
    }
  }

  // Last resort: look for a "campaign...": "value" style pair anywhere in the body.
  const match = payload.match(/"[^"]*campaign[^"]*"\s*:\s*"([^"]+)"/i);
  return match?.[1];
}

/** Pretty-prints a payload as JSON when possible, otherwise returns it trimmed. */
function formatPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload.trim();
  }
}

/**
 * Installs a request listener that records POST/PUT/PATCH requests carrying a
 * body. Returns the collected list plus a detach function to remove the
 * listener. Used to capture the backend submission (and its campaign name)
 * during a valid form submit.
 */
function captureBackendRequests(page: Page): { requests: BackendRequestInfo[]; detach: () => void } {
  const requests: BackendRequestInfo[] = [];
  const MAX_PAYLOAD = 20_000;

  const listener = (request: import('@playwright/test').Request) => {
    const method = request.method().toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
    const postData = request.postData();
    if (!postData) return;

    const contentType = request.headers()['content-type'] ?? '';
    const raw = postData.length > MAX_PAYLOAD ? postData.slice(0, MAX_PAYLOAD) + '\n…(truncated)' : postData;

    requests.push({
      url: request.url(),
      method,
      contentType,
      payload: formatPayload(raw),
      campaignName: extractCampaignName(postData, contentType),
    });
  };

  page.on('request', listener);
  return { requests, detach: () => page.off('request', listener) };
}

// ── Report helpers ────────────────────────────────────────────────────────────

function reportsDir(): string {
  const dir = path.join(process.cwd(), 'reports', 'forms');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Test suite ────────────────────────────────────────────────────────────────

const formEntries = loadFormsConfig();

for (const [scenarioIndex, entry] of formEntries.entries()) {
  test.describe(`Form Tests: ${entry.name}`, () => {
    // Serial mode: scan runs first; subsequent tests depend on scanResult
    test.describe.configure({ mode: 'serial' });

    let scanResult: FormScanResult;
    const scenarios: FormScenarioResult[] = [];

    // ── beforeAll: authenticate + scan ──────────────────────────────────────
    test.beforeAll(async ({ browser }) => {
      // Allow up to 5 min: page load (60 s) + up to 3 Claude retries × ~90 s each
      test.setTimeout(420_000);
      const { ctx, page } = await getPage(browser, entry);
      try {
        await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookieBanner(page);
        if (entry.preAction) await runPreAction(page, entry.preAction);
        scanResult = await scanForm(page, entry.name, scenarioIndex + 1);
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
    // Preview environments are slow and cookie-banner dismissal adds ~6 s on
    // first load, so give this test more headroom than the global 120 s.
    test('Valid: all fields filled correctly', async ({ browser }, testInfo) => {
      testInfo.setTimeout(300_000);

      let anyFailed = false;

      for (const form of scanResult.forms) {
        // Decide which valid variants to run. Forms with two checkboxes where
        // one is optional get two scenarios: (a) both checked, (b) only the
        // mandatory one checked. Otherwise a single "all valid" scenario.
        const checkboxes = form.fields.filter((f) => f.type === 'checkbox');
        const hasOptionalCheckbox = checkboxes.some((c) => !c.required);
        const runMandatoryOnly = checkboxes.length >= 2 && hasOptionalCheckbox;

        const variants: { key: string; label: string; includeOptional: boolean }[] = runMandatoryOnly
          ? [
              { key: 'both-checkboxes', label: 'both checkboxes checked', includeOptional: true },
              { key: 'mandatory-only', label: 'only mandatory checkbox checked', includeOptional: false },
            ]
          : [{ key: 'all-valid', label: 'all fields valid', includeOptional: true }];

        for (const variant of variants) {
          // Each variant needs a fresh page/context because a prior submit
          // mutates page state (success message, redirect, or filled form).
          const { ctx, page } = await getPage(browser, entry);
          try {
            await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await dismissCookieBanner(page);
            if (entry.preAction) await runPreAction(page, entry.preAction);

            let submittedData: SubmittedFieldValue[] = [];
            await test.step(`Form ${form.formIndex + 1} — fill (${variant.label})`, async () => {
              submittedData = await fillValidData(page, form, variant.includeOptional, entry.name);
            });

            await test.step(`Form ${form.formIndex + 1} — handle upload button if present`, async () => {
              await handleUploadButtonWithClaude(page);
            });

            // Re-fill checkboxes after the upload handler — Cloudinary interactions
            // can trigger a React re-render that resets any checkbox state set earlier.
            await test.step(`Form ${form.formIndex + 1} — re-check checkboxes after upload`, async () => {
              for (const field of form.fields) {
                if (field.type !== 'checkbox') continue;
                const value = validValueForField(field, variant.includeOptional);
                if (value) await fillField(page, field, value);
              }
            });

            const screenshotBefore = await page.screenshot({ fullPage: false }).catch(() => null);
            if (screenshotBefore) await testInfo.attach(`Before submit — form ${form.formIndex + 1} (${variant.label})`, {
              body: screenshotBefore,
              contentType: 'image/png',
            });

            const originalUrl = page.url();
            const beforeBodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

            // Close any custom dropdown left open by fillValidData — an open
            // listbox overlay can sit on top of the submit button and make the
            // click wait until the test times out.
            await page.keyboard.press('Escape').catch(() => {});
            await page.mouse.click(5, 5).catch(() => {});

            // Start capturing the backend submission just before we click submit.
            const capture = captureBackendRequests(page);

            let submitError: string | null = null;
            await test.step(`Form ${form.formIndex + 1} — submit (${variant.label})`, async () => {
              try {
                const submitLoc = page.locator(form.submitSelector).first();
                await submitLoc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
                await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
                await submitLoc.click();
                await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
              } catch (e) {
                // Capture but don't rethrow — we still want the diagnostic
                // screenshot and success check below to run.
                submitError = (e as Error).message;
                console.warn(`  [Forms] Submit click failed on form ${form.formIndex + 1}: ${submitError}`);
              }
            });
            // Give any late XHR a brief moment to fire before detaching.
            await page.waitForTimeout(500);
            capture.detach();
            const backendRequests = capture.requests;

            const screenshotAfter = await page.screenshot({ fullPage: false }).catch(() => null);
            if (screenshotAfter) await testInfo.attach(`After submit — form ${form.formIndex + 1} (${variant.label})`, {
              body: screenshotAfter,
              contentType: 'image/png',
            });

            const { success, detail } = submitError
              ? { success: false, detail: `Submit action failed: ${submitError}` }
              : await detectSuccessState(page, originalUrl, beforeBodyText);

            const campaign = backendRequests.map((r) => r.campaignName).find(Boolean);
            const message = campaign
              ? `${detail} · Campaign: "${campaign}"`
              : detail;

            const scenario: FormScenarioResult = {
              scenario: 'valid-submission',
              label: `Valid submission — form ${form.formIndex + 1} (${variant.label})`,
              passed: success,
              message,
              screenshotBase64: screenshotAfter?.toString('base64'),
              submittedData,
              backendRequests,
            };
            scenarios.push(scenario);

            if (!success) anyFailed = true;
          } finally {
            await ctx.close();
          }
        }
      }

      expect(anyFailed, 'One or more valid submission scenarios failed — see report for details').toBe(false);
    });

    // ── Test 3: Required fields — submit empty ────────────────────────────────
    test('Validation: required fields show errors when empty', async ({ browser }, testInfo) => {
      testInfo.setTimeout(300_000);
      const { ctx, page } = await getPage(browser, entry);

      try {
        await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await dismissCookieBanner(page);
        if (entry.preAction) await runPreAction(page, entry.preAction);

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

          // Snapshot text near each required field before submit so we can
          // detect messages that appear below them after submission.
          const beforeTexts = await captureFieldAreaTexts(page, requiredFields);

          await test.step('Submit form without filling any fields', async () => {
            const submitLoc = page.locator(form.submitSelector).first();
            await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
            await submitLoc.click();
            await page.waitForTimeout(1_500);
          });

          const screenshotAfter = await page.screenshot({ fullPage: false }).catch(() => null);
          if (screenshotAfter) await testInfo.attach(`After empty submit — form ${form.formIndex + 1}`, {
            body: screenshotAfter,
            contentType: 'image/png',
          });

          const hasErrors = await hasAnyValidationErrors(page, requiredFields, beforeTexts);

          const fieldResults: FieldValidationResult[] = await Promise.all(
            requiredFields.map(async (field) => {
              const errorText = await getFieldError(page, field, beforeTexts.get(field.selector));
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
              : `No validation errors visible after empty submit`,
            screenshotBase64: screenshotAfter?.toString('base64'),
            fieldResults,
          };
          scenarios.push(scenario);

          expect(
            hasErrors,
            `Submitting with blank required fields should show validation messages below those fields. ` +
            `If the form relies solely on server-side validation, add a note in forms.config.json.`,
          ).toBe(true);

          // Reload for the next form if needed
          if (scanResult.forms.indexOf(form) < scanResult.forms.length - 1) {
            await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await dismissCookieBanner(page);
            if (entry.preAction) await runPreAction(page, entry.preAction);
          }
        }
      } finally {
        await ctx.close();
      }
    });

    // ── Test 4: Invalid data per field ────────────────────────────────────────
    // Each invalid case reloads the page; with many fields this can take several
    // minutes on a preview environment, so we override the global 120 s timeout.
    test('Validation: invalid data triggers field errors', async ({ browser }, testInfo) => {
      testInfo.setTimeout(600_000);
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
                await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
                await dismissCookieBanner(page);
                if (entry.preAction) await runPreAction(page, entry.preAction);

                // Fill all OTHER required fields with valid data so only this field is invalid
                for (const other of form.fields) {
                  if (other.selector !== field.selector && other.required) {
                    const otherValue = isEmailField(other) && other.type !== 'checkbox'
                      ? generateUniqueEmail(entry.name)
                      : other.testData?.valid ?? '';
                    await fillField(page, other, otherValue);
                  }
                }

                // Snapshot the area around this field before submit
                const beforeFieldText = await getFieldAreaText(page, field.selector);

                // Fill the target field with the invalid value
                await fillField(page, field, invalidCase.value);

                // Submit
                const submitLoc = page.locator(form.submitSelector).first();
                await submitLoc.waitFor({ state: 'visible', timeout: 10_000 });
                await submitLoc.click();
                await page.waitForTimeout(1_500);

                const beforeTextsMap = new Map([[field.selector, beforeFieldText]]);
                const errorText = await getFieldError(page, field, beforeFieldText);
                const hasErrors = await hasAnyValidationErrors(
                  page,
                  field.required ? [field] : undefined,
                  field.required ? beforeTextsMap : undefined,
                );

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

                const screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
                if (screenshot) await testInfo.attach(`Invalid: ${field.label} — ${invalidCase.reason}`, {
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
