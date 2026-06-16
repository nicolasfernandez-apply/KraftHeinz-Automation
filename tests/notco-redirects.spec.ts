import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SITEMAP_URL = 'https://www.kraftheinz.com/sitemap.xml';
const NOTCO_PATTERN = '/notco/';

const VALID_CONDITIONS = [
  { id: 'plant-based',  label: 'Redirected to /plant-based',        check: (url: string, _body: string) => url.endsWith('/plant-based') },
  { id: 'error-en',     label: 'Error page (EN): Watch Out!',        check: (_url: string, body: string) => body.includes('Watch Out!') && body.includes('This page is broken') },
  { id: 'error-fr',     label: 'Error page (FR): Attention!',        check: (_url: string, body: string) => body.includes('Attention!') && body.includes('Cette page est cassée') },
] as const;

type ConditionId = typeof VALID_CONDITIONS[number]['id'];

interface RowResult {
  sourceUrl:  string;
  finalUrl:   string | null;
  condition:  ConditionId | null;
  passed:     boolean;
  error:      string | null;
  status:     'pass' | 'fail' | 'error' | 'skipped';
}

const reportsDir = path.join(process.cwd(), 'reports', 'notco-redirects');
fs.rmSync(reportsDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });

// Disable per-test timeout — sitemap fetch + many pages can take a while.
test.setTimeout(0);

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/g)].map((m) => m[1].trim());
}

function isSitemapIndex(xml: string): boolean {
  return xml.includes('<sitemapindex');
}

test('Notco redirects — all URLs', async ({ browser, request }, testInfo) => {
  // ── 1. Fetch and parse the sitemap (handles sitemap index files) ─────────
  console.log(`[notco-redirects] Fetching sitemap: ${SITEMAP_URL}`);
  const rootXml = await (await request.get(SITEMAP_URL)).text();

  let notcoUrls: string[];

  if (isSitemapIndex(rootXml)) {
    // It's a sitemap index — find sub-sitemaps that contain "/notco/" in their URL,
    // then fetch each one and collect all page URLs inside.
    const subSitemaps = extractLocs(rootXml).filter((u) => u.includes(NOTCO_PATTERN));
    console.log(`[notco-redirects] Sitemap index detected. Fetching ${subSitemaps.length} sub-sitemap(s)…`);

    const pageUrls: string[] = [];
    for (const sitemapUrl of subSitemaps) {
      console.log(`[notco-redirects]   → ${sitemapUrl}`);
      const subXml = await (await request.get(sitemapUrl)).text();
      pageUrls.push(...extractLocs(subXml));
    }
    notcoUrls = pageUrls.filter((u) => u.includes(NOTCO_PATTERN));
  } else {
    notcoUrls = extractLocs(rootXml).filter((u) => u.includes(NOTCO_PATTERN));
  }

  if (notcoUrls.length === 0) {
    throw new Error(`No URLs containing "${NOTCO_PATTERN}" found in the sitemap.`);
  }
  console.log(`[notco-redirects] Found ${notcoUrls.length} /notco/ URLs.`);

  // ── 2. Pre-populate rows as "skipped" ───────────────────────────────────
  const rows: RowResult[] = notcoUrls.map((url) => ({
    sourceUrl: url,
    finalUrl:  null,
    condition: null,
    passed:    false,
    error:     null,
    status:    'skipped',
  }));

  const writeReport = () => {
    const p = path.join(reportsDir, 'report.html');
    fs.writeFileSync(p, buildHtml(rows), 'utf8');
    console.log(`\n[notco-redirects] Report saved to: ${p}\n`);
    return p;
  };

  // ── 3. Check each URL ───────────────────────────────────────────────────
  try {
    for (let i = 0; i < notcoUrls.length; i++) {
      const sourceUrl = notcoUrls[i];
      const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();

      try {
        console.log(`[notco-redirects] (${i + 1}/${notcoUrls.length}) ${sourceUrl}`);
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        const finalUrl = page.url();
        const body     = await page.content();

        const matched = VALID_CONDITIONS.find((c) => c.check(finalUrl, body)) ?? null;
        const passed  = matched !== null;

        rows[i] = {
          sourceUrl,
          finalUrl,
          condition: matched?.id ?? null,
          passed,
          error:  null,
          status: passed ? 'pass' : 'fail',
        };

        console.log(`[notco-redirects]   → ${passed ? '✓' : '✗'} ${matched?.label ?? 'no matching condition'} (${finalUrl})`);
      } catch (err) {
        rows[i] = {
          sourceUrl,
          finalUrl: null,
          condition: null,
          passed:    false,
          error:     (err as Error).message,
          status:    'error',
        };
        console.warn(`[notco-redirects] ⚠ Error: ${sourceUrl} — ${(err as Error).message}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    const reportPath = writeReport();
    await testInfo.attach('Notco Redirects Report', {
      path:        reportPath,
      contentType: 'text/html',
    }).catch(() => {});
  }

  // Log a summary but never throw — the HTML report is the source of truth.
  const failed = rows.filter((r) => r.status === 'fail' || r.status === 'error');
  if (failed.length > 0) {
    console.warn(`\n[notco-redirects] ${failed.length} URL(s) did not meet any valid condition:`);
    failed.forEach((r) => console.warn(`  ${r.status.toUpperCase()}: ${r.sourceUrl} → ${r.finalUrl ?? '(no response)'}`));
  } else {
    console.log(`\n[notco-redirects] All ${rows.length} URLs passed.`);
  }
});

// ── HTML report ─────────────────────────────────────────────────────────────

function buildHtml(rows: RowResult[]): string {
  const timestamp = new Date().toLocaleString();
  const passed    = rows.filter((r) => r.status === 'pass').length;
  const failed    = rows.filter((r) => r.status === 'fail').length;
  const errored   = rows.filter((r) => r.status === 'error').length;
  const skipped   = rows.filter((r) => r.status === 'skipped').length;

  const conditionLabel: Record<string, string> = Object.fromEntries(
    VALID_CONDITIONS.map((c) => [c.id, c.label]),
  );

  const tableRows = rows.map((r) => {
    const rowClass = r.status === 'pass'    ? ''
                   : r.status === 'fail'    ? ' class="row-fail"'
                   : r.status === 'error'   ? ' class="row-error"'
                   : ' class="row-skipped"';

    const badge = r.status === 'pass'
      ? '<span class="badge badge-pass">pass</span>'
      : r.status === 'fail'
        ? '<span class="badge badge-fail">fail</span>'
        : r.status === 'error'
          ? '<span class="badge badge-error">error</span>'
          : '<span class="badge badge-skipped">skipped</span>';

    const finalCell = r.finalUrl
      ? `<a href="${escHtml(r.finalUrl)}" target="_blank">${escHtml(r.finalUrl)}</a>`
      : '<span class="na">—</span>';

    const conditionCell = r.condition
      ? escHtml(conditionLabel[r.condition] ?? r.condition)
      : r.error
        ? `<span class="error">⚠ ${escHtml(r.error)}</span>`
        : '<span class="na">—</span>';

    return `
      <tr${rowClass}>
        <td class="url"><a href="${escHtml(r.sourceUrl)}" target="_blank">${escHtml(r.sourceUrl)}</a></td>
        <td class="url">${finalCell}</td>
        <td>${conditionCell}</td>
        <td class="status-cell">${badge}</td>
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Notco Redirects Report</title>
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
    table { width: 100%; border-collapse: collapse; }
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
    td.url { max-width: 380px; word-break: break-all; }
    td.url a { color: #2563eb; text-decoration: none; }
    td.url a:hover { text-decoration: underline; }
    td.status-cell { text-align: center; white-space: nowrap; }
    .na { color: #bbb; }
    .error { font-size: 12px; color: #c0392b; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 3px; text-transform: uppercase; letter-spacing: .04em; }
    .badge-pass    { background: #d4edda; color: #1a6b3c; }
    .badge-fail    { background: #fde8e8; color: #c0392b; }
    .badge-error   { background: #fde8e8; color: #c0392b; }
    .badge-skipped { background: #f0f0f0; color: #888; }
    .row-fail    td { background: #fff8f8; }
    .row-error   td { background: #fff8f8; }
    .row-skipped td { background: #fafafa; color: #aaa; }
    .row-skipped td.url a { color: #999; }
    .legend { margin-top: 16px; font-size: 12px; color: #888; line-height: 1.8; }
    .legend ul { padding-left: 18px; }
  </style>
</head>
<body>
  <header>
    <h1>Notco Redirects Report</h1>
    <p>Verifies that every /notco/ URL redirects to an expected destination or error page</p>
  </header>
  <div class="meta">
    <span><strong>Sitemap:</strong> ${escHtml(SITEMAP_URL)}</span>
    <span><strong>URLs checked:</strong> ${rows.length}</span>
    <span><strong>Results:</strong> ${passed} passed · ${failed} failed · ${errored} errors · ${skipped} skipped</span>
    <span><strong>Generated:</strong> ${timestamp}</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Source URL</th>
          <th>Final URL</th>
          <th>Condition matched</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>
  <p class="legend">
    Valid conditions:
    <ul>
      ${VALID_CONDITIONS.map((c) => `<li><strong>${escHtml(c.label)}</strong></li>`).join('\n      ')}
    </ul>
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
