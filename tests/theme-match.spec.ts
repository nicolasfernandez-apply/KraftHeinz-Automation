import { test } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { analyzePage } from '../utils/analyzer';
import { loadTokenSets } from '../utils/token-loader';

interface ThemeMatchConfig {
  /** URLs to analyse — one row per URL in the final report. */
  urls: string[];
  /**
   * Path (relative to repo root) to a folder containing *.tokens.json files.
   * Every token file in the folder is treated as a candidate theme; the
   * analyzer picks the one with the fewest element violations per URL.
   */
  tokensFolder: string;
}

const configPath = process.env.THEME_MATCH_CONFIG
  ?? path.resolve(process.cwd(), 'theme-match.config.json');

if (!fs.existsSync(configPath)) {
  throw new Error(
    `\n  Theme match config not found: ${configPath}\n` +
    '  Create theme-match.config.json in the repo root, or set THEME_MATCH_CONFIG.\n',
  );
}

const config: ThemeMatchConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.urls || config.urls.length === 0) {
  throw new Error('Config must include `urls` (non-empty string array).');
}
if (!config.tokensFolder) {
  throw new Error('Config must include `tokensFolder`.');
}

const tokensFolderAbs = path.isAbsolute(config.tokensFolder)
  ? config.tokensFolder
  : path.resolve(process.cwd(), config.tokensFolder);

const tokenSets = loadTokenSets(tokensFolderAbs);
if (tokenSets.length === 0) {
  throw new Error(`No *.tokens.json files found in: ${tokensFolderAbs}`);
}

console.log(`[theme-match] ${tokenSets.length} token sets loaded from "${config.tokensFolder}":`);
tokenSets.forEach((s) => console.log(`  · ${s.name}`));

const reportsDir = path.join(process.cwd(), 'reports', 'theme-match');
fs.rmSync(reportsDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });

interface RowResult {
  url:          string;
  title:        string;
  theme:        string | null;
  themes:       string[];
  elementScore: number | null;
  colorViolations: number | null;
  fontViolations:  number | null;
  loadError:    string | null;
  /** 'ok' | 'error' | 'skipped' (URL not reached before test was interrupted) */
  status: 'ok' | 'error' | 'skipped';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Disable Playwright's built-in test timeout — with many URLs each page load
// can take up to 70 s (60 s goto + 10 s networkidle), so the default 30 s
// budget would abort the run before the first URL finishes.
test.setTimeout(0);

test('Theme match — all URLs', async ({ browser }, testInfo) => {
  const rows: RowResult[] = [];
  // Pre-populate every URL as 'skipped' so that if the test is interrupted
  // mid-loop (e.g. a hard process kill) the report still lists every URL.
  for (const url of config.urls) {
    rows.push({
      url,
      title: '—',
      theme: null,
      themes: [],
      elementScore: null,
      colorViolations: null,
      fontViolations: null,
      loadError: null,
      status: 'skipped',
    });
  }

  const writeReport = () => {
    const reportPath = path.join(reportsDir, 'report.html');
    fs.writeFileSync(reportPath, buildHtml(rows, config), 'utf8');
    console.log(`\n[theme-match] Report saved to: ${reportPath}\n`);
    return reportPath;
  };

  try {
    for (let i = 0; i < config.urls.length; i++) {
      const url = config.urls[i];
      const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();

      try {
        console.log(`[theme-match] (${i + 1}/${config.urls.length}) Analysing ${url}…`);
        const slug           = slugify(new URL(url).pathname || 'home') || 'page';
        const screenshotPath = path.join(reportsDir, `${slug}.png`);

        const analysis = await analyzePage(page, url, screenshotPath, tokenSets);

        const dtv = analysis.designTokenViolations;
        const elementScore = dtv
          ? dtv.unknownColors.reduce((s, c) => s + c.count, 0) +
            dtv.unknownFonts.reduce((s, f) => s + f.count, 0)
          : null;

        rows[i] = {
          url,
          title:           analysis.metadata.title || '—',
          theme:           analysis.matchedTokenSet,
          themes:          analysis.matchedTokenSets,
          elementScore,
          colorViolations: dtv?.unknownColors.length ?? null,
          fontViolations:  dtv?.unknownFonts.length  ?? null,
          loadError:       analysis.loadError,
          status:          analysis.loadError ? 'error' : 'ok',
        };

        console.log(
          `[theme-match] "${analysis.matchedTokenSet}" — ${elementScore ?? '?'} element violations`,
        );
      } catch (err) {
        rows[i] = {
          url,
          title:           '—',
          theme:           null,
          themes:          [],
          elementScore:    null,
          colorViolations: null,
          fontViolations:  null,
          loadError:       (err as Error).message,
          status:          'error',
        };
        console.warn(`[theme-match] ⚠ Failed: ${url} — ${(err as Error).message}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    // Always write the report — even if the loop was interrupted.
    const reportPath = writeReport();
    await testInfo.attach('Theme Match Report', {
      path:        reportPath,
      contentType: 'text/html',
    }).catch(() => {/* attach may fail if testInfo is torn down; report is still on disk */});
  }
});

function buildHtml(rows: RowResult[], cfg: ThemeMatchConfig): string {
  const timestamp = new Date().toLocaleString();
  const themeCount = tokenSets.length;

  const completed = rows.filter((r) => r.status === 'ok').length;
  const errored   = rows.filter((r) => r.status === 'error').length;
  const skipped   = rows.filter((r) => r.status === 'skipped').length;

  const tableRows = rows.map((r) => {
    const rowClass = r.status === 'skipped' ? ' class="row-skipped"'
                   : r.status === 'error'   ? ' class="row-error"'
                   : '';

    const scoreCell = r.elementScore === null
      ? '<td class="na">—</td>'
      : `<td class="score">${r.elementScore.toLocaleString()}</td>`;

    const colorCell = r.colorViolations === null
      ? '<td class="na">—</td>'
      : `<td>${r.colorViolations}</td>`;

    const fontCell = r.fontViolations === null
      ? '<td class="na">—</td>'
      : `<td>${r.fontViolations}</td>`;

    const themeCell = r.themes.length > 1
      ? `<td class="theme"><ul class="theme-list">${r.themes.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul></td>`
      : r.theme
        ? `<td class="theme">${escHtml(r.theme)}</td>`
        : '<td class="na">—</td>';

    const statusBadge = r.status === 'skipped'
      ? '<span class="badge badge-skipped">skipped</span> '
      : r.status === 'error'
        ? '<span class="badge badge-error">error</span> '
        : '';

    const errorNote = r.loadError
      ? `<br><span class="error">⚠ ${escHtml(r.loadError)}</span>`
      : '';

    return `
      <tr${rowClass}>
        <td class="url">${statusBadge}<a href="${escHtml(r.url)}" target="_blank">${escHtml(r.url)}</a>${errorNote}</td>
        <td class="title">${escHtml(r.title)}</td>
        ${themeCell}
        ${scoreCell}
        ${colorCell}
        ${fontCell}
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Theme Match Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      background: #f5f5f5;
      color: #222;
      padding: 24px;
    }
    header {
      background: #1a1a2e;
      color: #fff;
      padding: 20px 24px;
      border-radius: 8px 8px 0 0;
    }
    header h1 { font-size: 20px; font-weight: 600; }
    header p  { font-size: 13px; color: #aaa; margin-top: 4px; }
    .meta {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-top: none;
      padding: 12px 24px;
      display: flex;
      gap: 32px;
      font-size: 13px;
      color: #555;
    }
    .meta strong { color: #222; }
    .table-wrap {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-top: none;
      border-radius: 0 0 8px 8px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    thead th {
      background: #2d2d44;
      color: #fff;
      padding: 10px 14px;
      text-align: left;
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .05em;
      white-space: nowrap;
    }
    tbody tr { border-bottom: 1px solid #f0f0f0; }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #fafafa; }
    td { padding: 10px 14px; vertical-align: top; line-height: 1.4; }
    td.url { max-width: 360px; word-break: break-all; }
    td.url a { color: #2563eb; text-decoration: none; }
    td.url a:hover { text-decoration: underline; }
    td.title { max-width: 260px; color: #444; }
    td.theme { font-weight: 500; color: #1a6b3c; white-space: nowrap; }
    td.theme .theme-list { margin: 0; padding: 0; list-style: none; }
    td.theme .theme-list li + li { margin-top: 4px; }
    td.score { font-weight: 700; text-align: right; }
    td.na { color: #bbb; text-align: center; }
    .error { font-size: 12px; color: #c0392b; }
    .badge { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: .04em; vertical-align: middle; margin-right: 4px; }
    .badge-error   { background: #fde8e8; color: #c0392b; }
    .badge-skipped { background: #f0f0f0; color: #888; }
    .row-error   td { background: #fff8f8; }
    .row-skipped td { background: #fafafa; color: #aaa; }
    .row-skipped td.url a { color: #999; }
    tbody td:nth-child(4),
    tbody td:nth-child(5),
    tbody td:nth-child(6) { text-align: right; }
    thead th:nth-child(4),
    thead th:nth-child(5),
    thead th:nth-child(6) { text-align: right; }
    .legend {
      margin-top: 16px;
      font-size: 12px;
      color: #888;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <header>
    <h1>Theme Match Report</h1>
    <p>Best-matching design token palettes per URL, ranked by element violations</p>
  </header>
  <div class="meta">
    <span><strong>Token folder:</strong> ${escHtml(cfg.tokensFolder)}</span>
    <span><strong>Candidates:</strong> ${themeCount}</span>
    <span><strong>URLs:</strong> ${rows.length} &nbsp;(${completed} completed, ${errored} errored, ${skipped} skipped)</span>
    <span><strong>Generated:</strong> ${timestamp}</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>URL</th>
          <th>Page Title</th>
          <th>Best Themes</th>
          <th>Element Violations</th>
          <th>Color Violations</th>
          <th>Font Violations</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
  <p class="legend">
    <strong>Element Violations</strong> — sum of element counts across all unknown colors + unknown fonts for the winning theme (lower is better).<br>
    <strong>Color / Font Violations</strong> — number of <em>distinct</em> colors / font families not found in the winning theme's token set.
  </p>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
