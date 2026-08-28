import { GrammarAnalysisResult, GrammarIssue } from './grammar-analyzer';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityBadge(severity: GrammarIssue['severity']): string {
  const label = severity === 'error' ? 'Error' : 'Warning';
  const color = severity === 'error' ? '#d93025' : '#f29900';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:#fff;background:${color}">${label}</span>`;
}

function categoryBadge(category: string): string {
  const colors: Record<string, string> = {
    grammar: '#1a73e8',
    spelling: '#9334e6',
    punctuation: '#e67700',
    style: '#0f9d58',
    clarity: '#00838f',
  };
  const color = colors[category.toLowerCase()] ?? '#555';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;color:#fff;background:${color}">${esc(category)}</span>`;
}

function issueRow(issue: GrammarIssue, index: number): string {
  return `
    <tr style="border-bottom:1px solid #e0e0e0">
      <td style="padding:12px 8px;vertical-align:top;color:#555;font-size:13px">${index + 1}</td>
      <td style="padding:12px 8px;vertical-align:top">${severityBadge(issue.severity)}</td>
      <td style="padding:12px 8px;vertical-align:top">${categoryBadge(issue.category)}</td>
      <td style="padding:12px 8px;vertical-align:top;font-size:14px">${esc(issue.issue)}</td>
      <td style="padding:12px 8px;vertical-align:top">
        <span style="display:block;background:#fce8e6;border-left:3px solid #d93025;padding:4px 8px;font-size:13px;font-family:monospace;border-radius:2px;margin-bottom:4px">${esc(issue.originalText)}</span>
        ${issue.suggestion
          ? `<span style="display:block;background:#e6f4ea;border-left:3px solid #0f9d58;padding:4px 8px;font-size:13px;font-family:monospace;border-radius:2px">${esc(issue.suggestion)}</span>`
          : '<span style="color:#999;font-size:12px">No suggestion available</span>'}
      </td>
    </tr>`;
}

export function generateGrammarReport(result: GrammarAnalysisResult): string {
  const errors = result.issues.filter(i => i.severity === 'error').length;
  const warnings = result.issues.filter(i => i.severity === 'warning').length;

  const rows = result.issues.length > 0
    ? result.issues.map((issue, i) => issueRow(issue, i)).join('\n')
    : `<tr><td colspan="5" style="padding:24px;text-align:center;color:#0f9d58;font-size:15px">
        ✓ No grammar or spelling issues found.
       </td></tr>`;

  const formattedDate = new Date(result.analyzedAt).toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Grammar Report — ${esc(result.pageTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #202124; padding: 32px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .meta { font-size: 13px; color: #5f6368; margin-bottom: 24px; }
    .meta a { color: #1a73e8; text-decoration: none; }
    .summary-box { background: #fff; border: 1px solid #dadce0; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
    .summary-box h2 { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: #3c4043; }
    .summary-box p { font-size: 14px; line-height: 1.6; color: #3c4043; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat { background: #fff; border: 1px solid #dadce0; border-radius: 8px; padding: 16px 24px; min-width: 140px; text-align: center; }
    .stat-number { font-size: 32px; font-weight: 700; }
    .stat-label { font-size: 12px; color: #5f6368; margin-top: 4px; }
    .stat-errors .stat-number { color: #d93025; }
    .stat-warnings .stat-number { color: #f29900; }
    .stat-total .stat-number { color: #1a73e8; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dadce0; border-radius: 8px; overflow: hidden; }
    thead th { background: #f1f3f4; padding: 12px 8px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: #3c4043; }
    tbody tr:hover { background: #f8f9fa; }
    footer { margin-top: 32px; font-size: 12px; color: #9aa0a6; text-align: center; }
  </style>
</head>
<body>
  <h1>Grammar & Spelling Report</h1>
  <p class="meta">
    <strong>Page:</strong> ${esc(result.pageTitle)} &nbsp;|&nbsp;
    <strong>URL:</strong> <a href="${esc(result.url)}" target="_blank">${esc(result.url)}</a> &nbsp;|&nbsp;
    <strong>Language:</strong> ${esc(result.language)} &nbsp;|&nbsp;
    <strong>Analyzed:</strong> ${formattedDate}
  </p>

  <div class="stats">
    <div class="stat stat-total">
      <div class="stat-number">${result.issues.length}</div>
      <div class="stat-label">Total Issues</div>
    </div>
    <div class="stat stat-errors">
      <div class="stat-number">${errors}</div>
      <div class="stat-label">Errors</div>
    </div>
    <div class="stat stat-warnings">
      <div class="stat-number">${warnings}</div>
      <div class="stat-label">Warnings</div>
    </div>
  </div>

  ${result.summary ? `
  <div class="summary-box">
    <h2>Summary</h2>
    <p>${esc(result.summary)}</p>
  </div>` : ''}

  <table>
    <thead>
      <tr>
        <th style="width:40px">#</th>
        <th style="width:90px">Severity</th>
        <th style="width:110px">Category</th>
        <th style="width:240px">Issue</th>
        <th>Text / Suggestion</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <footer>Generated by KraftHeinz Grammar Checker · ${formattedDate}</footer>
</body>
</html>`;
}
