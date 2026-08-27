import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

interface PreActionDef {
  description?: string;
  prompt: string;
}

interface PreActionsConfig {
  actions: Record<string, PreActionDef>;
}

interface PreActionStep {
  action: 'click' | 'fill';
  selector: string;
  /** Required when action is "fill" */
  value?: string;
  description?: string;
}

interface ClaudePreActionResult {
  found: boolean;
  steps: PreActionStep[];
  confidence: 'high' | 'medium' | 'low';
}

const CONFIG_PATH = path.resolve(process.cwd(), 'pre-actions.config.json');

function loadConfig(): PreActionsConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `pre-actions.config.json not found at ${CONFIG_PATH}.\n` +
      'Create it in the project root with an "actions" map of named pre-actions.',
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as PreActionsConfig;
}

function findClaudeCli(): string {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 5_000 });
  if (!which.error && which.status === 0) return which.stdout.trim();

  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('claude CLI not found — install it with: npm install -g @anthropic-ai/claude-code');
}

/**
 * Fills a field robustly, handling native date inputs and masked/custom pickers.
 *
 * Strategy order:
 *   1. Native date input (type="date") — Playwright requires YYYY-MM-DD regardless
 *      of the display format, so we convert the value before calling fill().
 *   2. Standard fill() — works for plain text inputs.
 *   3. pressSequentially() — fallback for masked inputs that don't respond to fill()
 *      (e.g. custom date pickers that intercept keystrokes character by character).
 */
async function fillDateField(
  page: Page,
  loc: import('@playwright/test').Locator,
  value: string,
): Promise<void> {
  // Detect whether the element is a native date input.
  const inputType = await loc.evaluate((el) => (el as HTMLInputElement).type ?? '').catch(() => '');

  if (inputType === 'date') {
    // Native date inputs only accept YYYY-MM-DD. Convert from common display formats.
    const normalized = toISODate(value);
    console.log(`  [PreAction]   → native date input, using ISO value "${normalized}"`);
    await loc.fill(normalized, { timeout: 10_000 });
    return;
  }

  // Strategy 1: plain fill()
  await loc.click({ timeout: 5_000 });
  await loc.fill(value, { timeout: 10_000 });

  // Check whether the value actually landed — masked inputs often stay empty after fill().
  const actual = await loc.inputValue().catch(() => '');
  if (actual === value || actual.replace(/\D/g, '') === value.replace(/\D/g, '')) return;

  // Strategy 2: pressSequentially() — types character by character, triggering
  // masked-input event handlers that fill() bypasses.
  console.log(`  [PreAction]   → fill() did not set value; falling back to pressSequentially()`);
  await loc.clear({ timeout: 5_000 }).catch(() => {});
  await loc.pressSequentially(value, { delay: 80 });
}

/** Converts DD/MM/YYYY or MM/DD/YYYY or YYYY-MM-DD strings to YYYY-MM-DD. */
function toISODate(value: string): string {
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // DD/MM/YYYY or MM/DD/YYYY (ambiguous — assume DD/MM/YYYY as that's what the page shows)
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return value;
}

/**
 * Runs a named pre-action against the current page state.
 *
 * The action's prompt is combined with the page's HTML, sent to the Claude CLI,
 * and the response is parsed as a list of steps (fill / click). Steps are
 * executed in order, then the page is allowed to settle.
 *
 * @param page       The Playwright page (must already be on the target URL).
 * @param actionName The key in pre-actions.config.json to execute.
 */
export async function runPreAction(page: Page, actionName: string): Promise<void> {
  const config = loadConfig();
  const actionDef = config.actions[actionName];

  if (!actionDef) {
    throw new Error(
      `Pre-action "${actionName}" not found in pre-actions.config.json.\n` +
      `Available actions: ${Object.keys(config.actions).join(', ')}`,
    );
  }

  console.log(`\n  [PreAction] Running "${actionName}" — ${actionDef.description ?? 'no description'}`);

  // Grab a focused slice of the page HTML to avoid token limits.
  const pageHtml = await page.evaluate(() => {
    const el = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body;
    return (el?.innerHTML ?? document.body.innerHTML).slice(0, 30_000);
  }).catch(() => '');

  const fullPrompt = `${actionDef.prompt}\n\nHTML:\n${pageHtml}`;

  let result: ClaudePreActionResult;

  try {
    const claudePath = findClaudeCli();

    // Pass the prompt via stdin buffer — no shell, no temp file, no injection risk.
    const proc = spawnSync(claudePath, ['--print'], {
      input: fullPrompt,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    });

    if (proc.error) throw proc.error;
    if (proc.status !== 0) throw new Error(proc.stderr?.toString().trim() || `claude exited with code ${proc.status}`);

    const raw = (proc.stdout as string) ?? '';
    const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    result = JSON.parse(clean) as ClaudePreActionResult;
  } catch (e) {
    console.warn(`  [PreAction] Claude call failed — skipping pre-action "${actionName}": ${(e as Error).message}`);
    return;
  }

  if (!result.found || !result.steps?.length) {
    console.log(`  [PreAction] No matching elements found — skipping`);
    return;
  }

  console.log(`  [PreAction] Executing ${result.steps.length} step(s) (${result.confidence} confidence)`);

  for (const step of result.steps) {
    const loc = page.locator(step.selector).first();
    const visible = await loc.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!visible) {
      console.warn(`  [PreAction] Step "${step.action}" — selector not visible: ${step.selector}`);
      continue;
    }

    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});

    if (step.action === 'fill') {
      const value = step.value ?? '';
      console.log(`  [PreAction] fill "${step.description ?? step.selector}" → "${value}"`);
      await fillDateField(page, loc, value);
    } else {
      console.log(`  [PreAction] click "${step.description ?? step.selector}"`);
      await loc.click({ timeout: 10_000 });
    }

    // Brief pause between steps so the page can react (e.g. validation, focus shift).
    await page.waitForTimeout(500);
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  console.log(`  [PreAction] "${actionName}" completed successfully\n`);
}
