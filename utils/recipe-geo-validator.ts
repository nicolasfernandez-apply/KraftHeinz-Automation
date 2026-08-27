import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { spawnSync } from 'child_process';
import { Page } from '@playwright/test';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HardCheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface SoftCheckResult {
  id: string;
  label: string;
  score: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface RecipeGeoReport {
  url: string;
  environment: string;
  timestamp: string;
  hardChecks: HardCheckResult[];
  softChecks: SoftCheckResult[];
  screenshotBase64?: string;
}

// ── ISO 8601 duration regex ──────────────────────────────────────────────────

const ISO_DURATION_RE = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const PLACEHOLDER_RE = /^(N\/A|TBD|null|undefined|—|-|\.{2,})$/i;

// ── Hard requirement checks ──────────────────────────────────────────────────

export async function runHardChecks(page: Page): Promise<HardCheckResult[]> {
  const results: HardCheckResult[] = [];

  // Extract JSON-LD and DOM data in one evaluate call
  const pageData = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const jsonLdBlocks: any[] = [];
    for (const s of scripts) {
      try {
        const parsed = JSON.parse(s.textContent || '');
        // Handle @graph arrays
        if (parsed['@graph']) {
          jsonLdBlocks.push(...parsed['@graph']);
        } else if (Array.isArray(parsed)) {
          jsonLdBlocks.push(...parsed);
        } else {
          jsonLdBlocks.push(parsed);
        }
      } catch { /* skip invalid JSON */ }
    }

    const recipe = jsonLdBlocks.find(
      (b: any) => b['@type'] === 'Recipe' || (Array.isArray(b['@type']) && b['@type'].includes('Recipe')),
    );

    // Recipe Tips DOM check
    const recipeTipsEl = document.querySelector('[class*="recipe-tips"], [class*="recipeTips"], [class*="RecipeTips"], [data-testid*="recipe-tips"], [data-testid*="tips"], [class*="tips-block"], [class*="TipsBlock"], ml-text-block');
    const recipeTipsText = recipeTipsEl?.textContent ?? '';

    // Method steps
    const methodOl = document.querySelector('[class*="method"] ol, [class*="Method"] ol, [class*="instruction"] ol, [class*="Instruction"] ol, [class*="direction"] ol, [class*="Direction"] ol, [class*="steps"] ol, [class*="Steps"] ol, [data-testid*="method"] ol, [data-testid*="instruction"] ol, ol');
    const methodSteps: string[] = [];
    if (methodOl) {
      const lis = methodOl.querySelectorAll('li');
      lis.forEach((li) => methodSteps.push(li.textContent?.trim() ?? ''));
    }

    // Prep time from DOM
    const prepTimeEl = document.querySelector('[data-testid="or-recipe-header-prep-time"]');
    const prepTimeText = prepTimeEl?.textContent?.trim() ?? '';

    // Author in DOM
    const authorEl = document.querySelector('[class*="author"], [data-testid*="author"], [rel="author"]');
    const authorDomText = authorEl?.textContent?.trim() ?? '';

    // Full page text for soft checks
    const bodyText = document.body.innerText ?? '';

    return { recipe, recipeTipsText, prepTimeText, methodSteps, authorDomText, bodyText };
  });

  const recipe = pageData.recipe;

  // 1.1 JSON-LD Recipe exists
  results.push({
    id: 'jsonld-exists',
    label: 'JSON-LD Recipe schema present',
    passed: !!recipe,
    detail: recipe ? 'Found Recipe JSON-LD block' : 'No <script type="application/ld+json"> with @type "Recipe" found',
  });

  if (!recipe) return results;

  // 1.1 Required JSON-LD fields (cookTime and totalTime only — prepTime is DOM-rendered)
  const requiredDurations = ['cookTime', 'totalTime'] as const;
  for (const field of requiredDurations) {
    const val = recipe[field];
    const present = typeof val === 'string' && val.length > 0;
    const valid = present && ISO_DURATION_RE.test(val);
    results.push({
      id: `jsonld-${field}`,
      label: `JSON-LD ${field}`,
      passed: valid,
      detail: valid ? `${field}: ${val}` : present ? `${field} "${val}" is not valid ISO 8601 duration` : `${field} is missing or empty`,
    });
  }

  // 1.1 Prep time — rendered in DOM (not in JSON-LD)
  const prepTimeText = pageData.prepTimeText;
  results.push({
    id: 'dom-prep-time',
    label: 'Prep time rendered in DOM',
    passed: prepTimeText.length > 0,
    detail: prepTimeText.length > 0
      ? `Prep time found: "${prepTimeText}"`
      : 'No element found for [data-testid="or-recipe-header-prep-time"]',
  });

  const yield_ = recipe.recipeYield;
  const yieldPresent = (typeof yield_ === 'string' && yield_.length > 0) || typeof yield_ === 'number';
  results.push({
    id: 'jsonld-recipeYield',
    label: 'JSON-LD recipeYield',
    passed: yieldPresent,
    detail: yieldPresent ? `recipeYield: ${yield_}` : 'recipeYield is missing or empty',
  });

  // 1.1 Recipe Tips DOM
  const tipsText = pageData.recipeTipsText;
  const tipsKeywords = ['tip', 'note', 'pro tip', 'hint', 'suggestion', 'variation', 'try', 'make it'];
  const tipsHasContent = tipsText.length > 0 && tipsKeywords.some((kw) => tipsText.toLowerCase().includes(kw));
  const tipsHasPlaceholder = PLACEHOLDER_RE.test(tipsText.trim());
  results.push({
    id: 'dom-recipe-tips',
    label: 'Recipe tips block rendered in DOM',
    passed: tipsHasContent && !tipsHasPlaceholder,
    detail: tipsHasContent
      ? tipsHasPlaceholder ? 'Recipe tips block found but contains placeholder values' : 'Recipe tips block found with content'
      : 'No recipe tips block found on page',
  });

  // 1.2 Method steps as ordered list
  results.push({
    id: 'dom-method-ol',
    label: 'Method steps as ordered list (<ol>)',
    passed: pageData.methodSteps.length > 0,
    detail: pageData.methodSteps.length > 0
      ? `Found ${pageData.methodSteps.length} method steps in an <ol>`
      : 'No ordered list (<ol>) found for method steps',
  });

  // 1.2 Single action heuristic (steps under 80 words, no multiple paragraphs)
  if (pageData.methodSteps.length > 0) {
    const longSteps = pageData.methodSteps.filter((s) => s.split(/\s+/).length > 80);
    results.push({
      id: 'dom-method-step-length',
      label: 'Method steps — single action heuristic',
      passed: longSteps.length === 0,
      detail: longSteps.length === 0
        ? 'All steps are under 80 words'
        : `${longSteps.length} step(s) exceed 80 words — may contain multiple actions`,
    });
  }

  // 1.3 datePublished / dateModified
  const datePub = recipe.datePublished;
  const dateMod = recipe.dateModified;
  const hasDate = (typeof datePub === 'string' && ISO_DATE_RE.test(datePub)) ||
                  (typeof dateMod === 'string' && ISO_DATE_RE.test(dateMod));
  results.push({
    id: 'jsonld-dates',
    label: 'JSON-LD datePublished / dateModified',
    passed: hasDate,
    detail: hasDate
      ? `datePublished: ${datePub ?? '—'}, dateModified: ${dateMod ?? '—'}`
      : 'Neither datePublished nor dateModified found in valid ISO 8601 format',
  });

  // 1.3 Author
  const authorJsonLd = recipe.author;
  const hasAuthor = !!authorJsonLd || pageData.authorDomText.length > 0;
  results.push({
    id: 'jsonld-author',
    label: 'Author attribution',
    passed: hasAuthor,
    detail: hasAuthor
      ? `Author: ${typeof authorJsonLd === 'object' ? authorJsonLd?.name ?? JSON.stringify(authorJsonLd) : authorJsonLd ?? pageData.authorDomText}`
      : 'No author found in JSON-LD or DOM',
  });

  return results;
}

// ── Claude CLI helper ────────────────────────────────────────────────────────

function findClaudePath(): string {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 5_000 });
  if (!which.error && which.status === 0) return which.stdout.trim();
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${process.env.HOME}/.npm-global/bin/claude`]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('claude CLI not found. Run: npm install -g @anthropic-ai/claude-code');
}

function callClaude(prompt: string): string {
  const claudePath = findClaudePath();
  const tmpFile = path.join(require('os').tmpdir(), `kh-recipe-geo-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    return execSync(`"${claudePath}" --print < "${tmpFile}"`, {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
      shell: '/bin/sh',
    }) as string;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ── Soft requirement checks ──────────────────────────────────────────────────

export async function runSoftChecks(page: Page): Promise<SoftCheckResult[]> {
  const pageContent = await page.evaluate(() => {
    const body = document.body.innerText ?? '';
    // Also grab ingredient list and method steps specifically
    const ingredientEls = document.querySelectorAll('[class*="ingredient"] li, [class*="Ingredient"] li, [data-testid*="ingredient"] li');
    const ingredients = Array.from(ingredientEls).map((el) => el.textContent?.trim() ?? '');

    const methodEls = document.querySelectorAll('[class*="method"] ol li, [class*="Method"] ol li, [class*="instruction"] ol li, [class*="Instruction"] ol li, [class*="direction"] ol li, [class*="steps"] ol li, ol li');
    const methodSteps = Array.from(methodEls).map((el) => el.textContent?.trim() ?? '');

    return { body: body.slice(0, 15_000), ingredients, methodSteps };
  });

  const guidelines = fs.readFileSync(path.resolve(process.cwd(), 'docs/recipeGeoGuidelines.md'), 'utf8');
  const softSection = guidelines.split('## 2. Soft Requirements')[1] ?? '';

  const prompt = `You are a QA analyst evaluating a Kraft Heinz recipe page against content guidelines.

Below are the SOFT REQUIREMENTS you must evaluate:

${softSection}

Here is the PAGE CONTENT:

--- BODY TEXT (first 15000 chars) ---
${pageContent.body}

--- INGREDIENT LIST ---
${pageContent.ingredients.length > 0 ? pageContent.ingredients.join('\n') : '(no structured ingredient list found)'}

--- METHOD STEPS ---
${pageContent.methodSteps.length > 0 ? pageContent.methodSteps.join('\n') : '(no method steps found)'}

Evaluate each soft requirement and return ONLY valid JSON (no markdown fences, no explanation) with this exact schema:

{
  "checks": [
    {
      "id": "opening-description",
      "label": "Opening Description Quality (Guideline 20)",
      "score": "pass | warn | fail",
      "detail": "one-sentence explanation of what was found"
    },
    {
      "id": "backstory-elimination",
      "label": "Backstory Elimination (Guideline 20)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "ingredient-measurements",
      "label": "Exact Quantities & Standard Measurements (Guideline 21)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "brand-name-compliance",
      "label": "Full Brand Name Compliance (Guideline 21)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "ingredient-method-alignment",
      "label": "Ingredient-Method Alignment (Guideline 21)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "method-step-granularity",
      "label": "Method Step Granularity (Guideline 22)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "method-step-extractability",
      "label": "Method Step Extractability (Guideline 22)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "substitutions-section",
      "label": "Substitutions & Variations Section (Guideline 24)",
      "score": "pass | warn | fail",
      "detail": "..."
    },
    {
      "id": "brand-storytelling",
      "label": "Brand Storytelling Alignment (NOW Roadmap)",
      "score": "pass | warn | fail",
      "detail": "..."
    }
  ]
}

Rules:
- "pass" = fully compliant
- "warn" = partially compliant or minor issues
- "fail" = clearly non-compliant
- Be specific in "detail" — cite actual text from the page when possible
- If a section is missing entirely from the page, score it "fail"`;

  let raw: string;
  try {
    console.log('  [RecipeGEO] Calling Claude CLI for soft requirement evaluation…');
    raw = callClaude(prompt);
  } catch (e) {
    console.warn(`  [RecipeGEO] Claude call failed: ${(e as Error).message}`);
    return [{
      id: 'claude-error',
      label: 'AI Evaluation',
      score: 'fail',
      detail: `Claude CLI call failed: ${(e as Error).message}`,
    }];
  }

  try {
    const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(clean);
    return (parsed.checks ?? []).map((c: any) => ({
      id: c.id ?? 'unknown',
      label: c.label ?? c.id ?? 'Unknown check',
      score: ['pass', 'warn', 'fail'].includes(c.score) ? c.score : 'warn',
      detail: c.detail ?? '',
    }));
  } catch (e) {
    console.warn(`  [RecipeGEO] Could not parse Claude response: ${(e as Error).message}`);
    return [{
      id: 'parse-error',
      label: 'AI Evaluation Parse Error',
      score: 'fail',
      detail: `Could not parse Claude response. Raw output: ${raw.slice(0, 500)}`,
    }];
  }
}

// ── HTML report generator ────────────────────────────────────────────────────

export function generateRecipeGeoReport(report: RecipeGeoReport): string {
  const hardPass = report.hardChecks.filter((c) => c.passed).length;
  const hardTotal = report.hardChecks.length;
  const softPass = report.softChecks.filter((c) => c.score === 'pass').length;
  const softWarn = report.softChecks.filter((c) => c.score === 'warn').length;
  const softFail = report.softChecks.filter((c) => c.score === 'fail').length;
  const softTotal = report.softChecks.length;

  const statusIcon = (passed: boolean) => passed ? '✅' : '❌';
  const scoreIcon = (score: string) => score === 'pass' ? '✅' : score === 'warn' ? '⚠️' : '❌';
  const scoreColor = (score: string) => score === 'pass' ? '#16a34a' : score === 'warn' ? '#ca8a04' : '#dc2626';

  const hardRows = report.hardChecks.map((c) => `
    <tr>
      <td>${statusIcon(c.passed)}</td>
      <td><strong>${c.label}</strong></td>
      <td>${c.detail}</td>
    </tr>`).join('');

  const softRows = report.softChecks.map((c) => `
    <tr>
      <td>${scoreIcon(c.score)}</td>
      <td><strong>${c.label}</strong></td>
      <td style="color:${scoreColor(c.score)}">${c.detail}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recipe GEO Guidelines Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; padding: 2rem; background: #f8fafc; color: #1e293b; }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .meta { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .summary { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .card { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex: 1; min-width: 200px; }
  .card h3 { font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem; }
  .card .value { font-size: 1.5rem; font-weight: 700; }
  .pass { color: #16a34a; } .warn { color: #ca8a04; } .fail { color: #dc2626; }
  h2 { font-size: 1.25rem; margin: 1.5rem 0 0.75rem; padding-bottom: 0.25rem; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: 0.625rem 0.75rem; border-bottom: 1px solid #f1f5f9; font-size: 0.875rem; }
  th { background: #f8fafc; font-weight: 600; color: #475569; }
  td:first-child { width: 2rem; text-align: center; }
  img { max-width: 100%; border-radius: 8px; margin-top: 1rem; }
</style>
</head>
<body>
<div class="container">
  <h1>Recipe GEO Guidelines Report</h1>
  <div class="meta">
    <strong>URL:</strong> ${report.url}<br>
    <strong>Environment:</strong> ${report.environment}<br>
    <strong>Generated:</strong> ${report.timestamp}
  </div>

  <div class="summary">
    <div class="card">
      <h3>Hard Requirements</h3>
      <div class="value ${hardPass === hardTotal ? 'pass' : 'fail'}">${hardPass} / ${hardTotal} passed</div>
    </div>
    <div class="card">
      <h3>Soft Requirements</h3>
      <div class="value">
        <span class="pass">${softPass}✓</span>
        <span class="warn">${softWarn}⚠</span>
        <span class="fail">${softFail}✗</span>
        <span style="color:#64748b;font-size:0.875rem"> / ${softTotal}</span>
      </div>
    </div>
  </div>

  <h2>Hard Requirements (Programmatic Validation)</h2>
  <table>
    <thead><tr><th></th><th>Check</th><th>Detail</th></tr></thead>
    <tbody>${hardRows}</tbody>
  </table>

  <h2>Soft Requirements (AI Evaluation)</h2>
  <table>
    <thead><tr><th></th><th>Check</th><th>Detail</th></tr></thead>
    <tbody>${softRows}</tbody>
  </table>

  ${report.screenshotBase64 ? `<h2>Page Screenshot</h2><img src="data:image/png;base64,${report.screenshotBase64}" alt="Page screenshot">` : ''}
</div>
</body>
</html>`;
}
