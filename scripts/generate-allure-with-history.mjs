/**
 * Generates the Allure report from allure-results/.
 *
 * Before running this script the workflow is expected to have already:
 *   1. Run `npm run compare`  (produces allure-results/)
 *   2. Injected previous history into allure-results/history  (via cache step)
 *
 * This script then:
 *   1. Writes environment.properties  (visible in the Allure "Environment" widget)
 *   2. Writes executor.json           (visible in the Allure "Executor" section)
 *   3. Runs `allure generate`         (produces allure-report/)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ALLURE_RESULTS = 'allure-results';
const ALLURE_REPORT  = 'allure-report';

// ── Ensure allure-results directory exists ────────────────────────────────────
fs.mkdirSync(ALLURE_RESULTS, { recursive: true });

// ── Resolve which URL config was used ────────────────────────────────────────
const urlsConfig = process.env.URLS_CONFIG ?? 'urls.config.json';
let configLabel  = urlsConfig;

try {
  const raw   = fs.readFileSync(urlsConfig, 'utf8');
  const data  = JSON.parse(raw);
  const pairs = data.comparisons ?? [];
  configLabel = pairs.map((p) => p.name ?? p.previewUrl).join(', ');
} catch {
  // Non-fatal — use the file path as the label
}

// ── Write environment.properties ─────────────────────────────────────────────
// These key=value pairs appear in the Allure "Environment" widget.
const envProperties = [
  `Environment=Preview vs Production`,
  `Config=${urlsConfig}`,
  `Pages=${configLabel}`,
  `Generated=${new Date().toISOString()}`,
  `Run=${process.env.GITHUB_RUN_NUMBER ?? 'local'}`,
].join('\n');

fs.writeFileSync(path.join(ALLURE_RESULTS, 'environment.properties'), envProperties);
console.log('Written: environment.properties');

// ── Write executor.json ───────────────────────────────────────────────────────
// Shows in Allure as the "Executor" card (build name, link to CI run, etc.).
const runNumber  = process.env.GITHUB_RUN_NUMBER ?? '0';
const runId      = process.env.GITHUB_RUN_ID      ?? '0';
const repo       = process.env.GITHUB_REPOSITORY  ?? '';
const serverUrl  = process.env.GITHUB_SERVER_URL   ?? 'https://github.com';
const buildUrl   = repo ? `${serverUrl}/${repo}/actions/runs/${runId}` : '';

const executor = {
  name:        'GitHub Actions',
  type:        'github',
  buildName:   `Run #${runNumber}`,
  buildUrl,
  reportName:  'KraftHeinz URL Comparison — Allure Report',
};

fs.writeFileSync(
  path.join(ALLURE_RESULTS, 'executor.json'),
  JSON.stringify(executor, null, 2),
);
console.log('Written: executor.json');

// ── Generate Allure report ────────────────────────────────────────────────────
console.log(`\nGenerating Allure report from ${ALLURE_RESULTS}/ → ${ALLURE_REPORT}/`);

execSync(
  `npx allure generate ${ALLURE_RESULTS} --clean -o ${ALLURE_REPORT}`,
  { stdio: 'inherit' },
);

console.log(`\nAllure report ready at: ${path.resolve(ALLURE_REPORT)}/index.html`);
