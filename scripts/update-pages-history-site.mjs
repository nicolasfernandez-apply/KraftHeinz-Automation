/**
 * Maintains the GitHub Pages report-history site.
 *
 * Expected: the workflow has already cloned / initialised the report-history
 * branch into PAGES_SITE_DIR (.pages-site) before calling this script.
 *
 * What this script does:
 *   1. Copies allure-report/ into .pages-site/reports/<runStamp>/
 *   2. Reads / creates .pages-site/history.json and prepends the new run
 *   3. Re-generates .pages-site/index.html (the dashboard)
 *   4. git add + commit inside .pages-site  (workflow handles the push)
 */

import { execSync } from 'child_process';
import fs           from 'fs';
import path         from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const PAGES_SITE_DIR    = process.env.PAGES_SITE_DIR    ?? '.pages-site';
const SOURCE_REPORT_DIR = process.env.SOURCE_REPORT_DIR ?? 'allure-report';
const URLS_CONFIG       = process.env.URLS_CONFIG       ?? 'urls.config.json';
const SITE_TITLE        = process.env.SITE_TITLE        ?? 'KraftHeinz URL Comparison';

const runNumber  = process.env.GITHUB_RUN_NUMBER  ?? '0';
const runId      = process.env.GITHUB_RUN_ID      ?? '0';
const repo       = process.env.GITHUB_REPOSITORY  ?? '';
const serverUrl  = process.env.GITHUB_SERVER_URL  ?? 'https://github.com';
const sha        = (process.env.GITHUB_SHA        ?? '').slice(0, 7);
const buildUrl   = repo ? `${serverUrl}/${repo}/actions/runs/${runId}` : '';

const runDate    = new Date();
// e.g. "2026-04-16T10-30-00-run-43"
const nowIso     = runDate.toISOString().replace(/:/g, '-').replace(/\..+/, '');
const runStamp   = `${nowIso}-run-${runNumber}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

function generateIndexHtml(runs) {
  const total    = runs.length;
  const lastRun  = runs[0];
  const lastDate = lastRun ? fmtDate(lastRun.date) : 'N/A';

  const rows = runs.map((run, i) => {
    const shaHtml = run.sha && repo
      ? `<a class="sha-link" href="${serverUrl}/${repo}/commit/${run.sha}" target="_blank">${escHtml(run.sha)}</a>`
      : escHtml(run.sha ?? '—');

    const runHtml = run.buildUrl
      ? `<a class="run-link" href="${escHtml(run.buildUrl)}" target="_blank">#${run.runNumber}</a>`
      : `#${run.runNumber}`;

    const isLatest = i === 0;

    return `
      <tr${isLatest ? ' class="latest"' : ''}>
        <td class="c-run">${runHtml}${isLatest ? ' <span class="latest-badge">latest</span>' : ''}</td>
        <td class="c-date">${fmtDate(run.date)}</td>
        <td class="c-sha">${shaHtml}</td>
        <td class="c-action">
          <a class="btn-report" href="${escHtml(run.reportPath)}" target="_blank">View Report →</a>
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${SITE_TITLE} — Run History</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; line-height: 1.6;
    }

    /* ── Header ── */
    header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      color: #fff; padding: 40px 48px 36px;
    }
    header h1 { font-size: 26px; font-weight: 700; }
    header p  { opacity: 0.6; font-size: 13px; margin-top: 4px; }
    .stats { display: flex; gap: 40px; margin-top: 28px; }
    .stat-val { font-size: 34px; font-weight: 700; line-height: 1; }
    .stat-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.55; margin-top: 4px; }

    /* ── Layout ── */
    main { max-width: 1200px; margin: 0 auto; padding: 28px 24px 56px; }

    /* ── Table card ── */
    .card { background: #fff; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.07); overflow: hidden; }

    table { width: 100%; border-collapse: collapse; }
    thead th {
      background: #f8f9fa; padding: 11px 16px; text-align: left;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #777; border-bottom: 2px solid #e9ecef;
    }
    tbody tr { transition: background 0.1s; }
    tbody tr:hover { background: #f5f8ff; }
    tbody tr.latest { background: #f0fdf4; }
    td { padding: 13px 16px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; font-size: 14px; }
    tbody tr:last-child td { border-bottom: none; }

    /* ── Cells ── */
    .c-run { white-space: nowrap; }
    .run-link { font-weight: 700; font-size: 15px; color: #2980b9; text-decoration: none; }
    .run-link:hover { text-decoration: underline; }
    .latest-badge {
      display: inline-block; background: #dcfce7; color: #166534;
      font-size: 10px; font-weight: 700; padding: 2px 7px;
      border-radius: 20px; margin-left: 6px; vertical-align: middle;
      text-transform: uppercase; letter-spacing: 0.5px;
    }

    .c-date { color: #555; font-size: 13px; white-space: nowrap; }

    .sha-link { font-family: monospace; font-size: 12px; color: #888; text-decoration: none; }
    .sha-link:hover { color: #333; text-decoration: underline; }

    .btn-report {
      display: inline-block; background: #0f3460; color: #fff;
      padding: 6px 14px; border-radius: 6px; font-size: 13px;
      font-weight: 600; text-decoration: none; white-space: nowrap;
    }
    .btn-report:hover { background: #16213e; }

    footer { text-align: center; color: #bbb; font-size: 12px; padding: 24px; }
  </style>
</head>
<body>
  <header>
    <h1>${SITE_TITLE}</h1>
    <p>Allure report history — click any row to open the full report for that run</p>
    <div class="stats">
      <div>
        <div class="stat-val">${total}</div>
        <div class="stat-lbl">Total Runs</div>
      </div>
      <div>
        <div class="stat-val" style="font-size:18px;padding-top:6px">${lastDate}</div>
        <div class="stat-lbl">Last Run</div>
      </div>
    </div>
  </header>

  <main>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Date (UTC)</th>
            <th>Commit</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4" style="color:#bbb;font-style:italic;padding:32px;text-align:center">No runs yet</td></tr>'}
        </tbody>
      </table>
    </div>
  </main>

  <footer>${SITE_TITLE}</footer>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Ensure the reports sub-directory exists in the site
fs.mkdirSync(path.join(PAGES_SITE_DIR, 'reports'), { recursive: true });

// 1. Copy the Allure report into the site
const destReportDir = path.join(PAGES_SITE_DIR, 'reports', runStamp);
console.log(`Copying ${SOURCE_REPORT_DIR}/ → ${destReportDir}/`);
fs.cpSync(SOURCE_REPORT_DIR, destReportDir, { recursive: true });

// 2. Read or initialise history.json
const historyPath = path.join(PAGES_SITE_DIR, 'history.json');
let history = { runs: [] };
if (fs.existsSync(historyPath)) {
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch {
    console.warn('history.json was unreadable — starting fresh');
  }
}

// Read page names from the URL config used for this run
let pages = [];
try {
  const raw    = fs.readFileSync(URLS_CONFIG, 'utf8');
  const config = JSON.parse(raw);
  pages = (config.comparisons ?? []).map(p => p.name ?? p.productionUrl);
} catch { /* non-fatal */ }

// Prepend the new run (newest first)
history.runs.unshift({
  runStamp,
  date:      runDate.toISOString(),
  runNumber: parseInt(runNumber, 10),
  runId,
  buildUrl,
  reportPath: `reports/${runStamp}/index.html`,
  pages,
  sha,
});

fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
console.log(`history.json updated — ${history.runs.length} run(s) recorded`);

// 3. Re-generate the dashboard index
const indexHtml = generateIndexHtml(history.runs);
fs.writeFileSync(path.join(PAGES_SITE_DIR, 'index.html'), indexHtml);
console.log('index.html generated');

// 4. Git commit
const gitOpts = { cwd: PAGES_SITE_DIR, stdio: 'inherit' };
execSync('git add -A', gitOpts);

const hasChanges = (() => {
  try {
    execSync('git diff --cached --exit-code', { cwd: PAGES_SITE_DIR, stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
})();

if (hasChanges) {
  execSync(
    `git commit -m "chore: add run #${runNumber} report [skip ci]"`,
    gitOpts,
  );
  console.log(`Committed run #${runNumber} to report-history`);
} else {
  console.log('Nothing to commit');
}
