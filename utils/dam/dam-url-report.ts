import { AssetResult, DamValidationResult } from './dam-url-validator';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function assetTable(assets: AssetResult[], showMatch: boolean): string {
  if (assets.length === 0) {
    return '<p class="empty">None.</p>';
  }

  const rows = assets.map((a) => `
      <tr>
        <td><span class="kind kind-${a.kind}">${a.kind}</span></td>
        <td class="url"><a href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">${escapeHtml(a.url)}</a></td>
        <td class="num">${a.occurrences}</td>
        <td class="mono">${a.sources.map(escapeHtml).join('<br>')}</td>
        <td class="mono">${a.selectors.map(escapeHtml).join('<br>')}</td>
        <td>${a.labels.map(escapeHtml).join('<br>')}</td>
        ${showMatch ? `<td class="mono">${escapeHtml(a.matchedTarget ?? '')}</td>` : ''}
      </tr>`).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Type</th><th>Asset URL</th><th>Refs</th><th>Found in</th><th>Element(s)</th><th>Label(s)</th>
          ${showMatch ? '<th>Matched target</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Builds a self-contained HTML report for one validated page. */
export function generateDamUrlReport(result: DamValidationResult): string {
  const total = result.passed.length + result.failed.length;
  const passRate = total === 0 ? 0 : Math.round((result.passed.length / total) * 100);
  const status = result.failed.length === 0 && total > 0 ? 'PASS' : 'FAIL';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DAM URL Validation — ${escapeHtml(result.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 32px; background: #f6f7f9; color: #1b1f24; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  .sub { color: #5b636d; font-size: 13px; margin-bottom: 24px; word-break: break-all; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 14px 18px; min-width: 120px; }
  .card .n { font-size: 24px; font-weight: 600; }
  .card .l { font-size: 12px; color: #5b636d; text-transform: uppercase; letter-spacing: .04em; }
  .status { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; }
  .status.PASS { background: #1a7f37; }
  .status.FAIL { background: #c0392b; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          border: 1px solid #e3e6ea; border-radius: 8px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { background: #f0f2f5; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #5b636d; }
  tr:last-child td { border-bottom: none; }
  .url { word-break: break-all; max-width: 520px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #444c56; }
  .num { text-align: right; font-variant-numeric: tabular-nums; color: #5b636d; }
  .kind { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: #e7ecf3; color: #2f3a45; }
  .kind-video { background: #efe3f7; color: #5b2b7b; }
  .empty { color: #5b636d; font-style: italic; }
  img.shot { max-width: 100%; border: 1px solid #e3e6ea; border-radius: 8px; background: #fff; }
</style>
</head>
<body>
  <h1>DAM URL Validation — ${escapeHtml(result.name)} <span class="status ${status}">${status}</span></h1>
  <div class="sub">
    <div>Page: <a href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(result.url)}</a></div>
    <div>Environment: ${escapeHtml(result.environment)}</div>
    <div>Target URL(s): ${escapeHtml(result.targetUrls.join(', '))}</div>
    <div>Generated: ${escapeHtml(result.generatedAt)}</div>
  </div>

  <div class="cards">
    <div class="card"><div class="n">${total}</div><div class="l">Assets found</div></div>
    <div class="card"><div class="n">${result.passed.length}</div><div class="l">Passed</div></div>
    <div class="card"><div class="n">${result.failed.length}</div><div class="l">Failed</div></div>
    <div class="card"><div class="n">${passRate}%</div><div class="l">Pass rate</div></div>
    <div class="card"><div class="n">${result.ignored.length}</div><div class="l">Ignored</div></div>
  </div>

  <h2>Failed — asset URL does not contain the target</h2>
  ${assetTable(result.failed, false)}

  <h2>Passed — asset URL contains the target</h2>
  ${assetTable(result.passed, true)}

  ${result.ignored.length > 0 ? `<h2>Ignored — excluded by the config ignore list</h2>
  ${assetTable(result.ignored, false)}` : ''}

  ${result.screenshotBase64 ? `<h2>Page screenshot</h2>
  <img class="shot" src="data:image/png;base64,${result.screenshotBase64}" alt="Full page screenshot">` : ''}
</body>
</html>`;
}

/** Flat CSV of every asset, one row each, for spreadsheet triage. */
export function generateDamUrlCsv(result: DamValidationResult): string {
  const escape = (value: string) => `"${(value ?? '').replace(/"/g, '""')}"`;
  const ignoredSet = new Set(result.ignored);
  const rows = [...result.failed, ...result.passed, ...result.ignored].map((a) => [
    result.name, result.url, a.kind, ignoredSet.has(a) ? 'IGNORED' : a.passed ? 'PASS' : 'FAIL',
    a.url, String(a.occurrences), a.sources.join(' | '), a.selectors.join(' | '),
    a.labels.join(' | '), a.matchedTarget ?? '',
  ].map(escape).join(','));

  return [
    'page_name,page_url,asset_type,result,asset_url,references,found_in,elements,labels,matched_target',
    ...rows,
  ].join('\n');
}
