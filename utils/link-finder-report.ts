export type LinkLocation = 'header' | 'footer' | 'nav' | 'main' | 'other';

export interface LinkMatch {
  pageUrl: string;
  locale: string;
  targetUrl: string;
  href: string;
  linkText: string;
  location: LinkLocation;
  occurrences: number;
}

export interface LinkFinderSummary {
  generatedAt: string;
  targetUrls: string[];
  locales: string[];
  pagesChecked: number;
  matches: LinkMatch[];
}

const CSV_COLUMNS: (keyof LinkMatch)[] = [
  'pageUrl', 'locale', 'targetUrl', 'href', 'linkText', 'location', 'occurrences',
];

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function generateLinkFinderCsv(matches: LinkMatch[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const m of matches) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(m[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function locationBadge(location: LinkLocation): string {
  const colors: Record<LinkLocation, string> = {
    header: '#1a73e8',
    footer: '#9334e6',
    nav: '#e67700',
    main: '#0f9d58',
    other: '#5f6368',
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;color:#fff;background:${colors[location]}">${location}</span>`;
}

function pageSection(pageUrl: string, matches: LinkMatch[]): string {
  const rows = matches.map((m) => `
      <tr style="border-bottom:1px solid #e0e0e0">
        <td style="padding:10px 8px;vertical-align:top">${locationBadge(m.location)}</td>
        <td style="padding:10px 8px;vertical-align:top;font-size:13px;font-family:monospace;word-break:break-all"><a href="${esc(m.href)}" target="_blank">${esc(m.href)}</a></td>
        <td style="padding:10px 8px;vertical-align:top;font-size:13px">${m.linkText ? esc(m.linkText) : '<span style="color:#999">(no text)</span>'}</td>
        <td style="padding:10px 8px;vertical-align:top;font-size:13px;color:#5f6368;word-break:break-all">${esc(m.targetUrl)}</td>
        <td style="padding:10px 8px;vertical-align:top;font-size:13px;text-align:right">${m.occurrences}</td>
      </tr>`).join('');

  return `
  <section class="page">
    <h2><a href="${esc(pageUrl)}" target="_blank">${esc(pageUrl)}</a> <span class="locale">${esc(matches[0].locale)}</span></h2>
    <table>
      <thead>
        <tr>
          <th style="width:90px">Location</th>
          <th>Link href</th>
          <th style="width:220px">Link text</th>
          <th style="width:240px">Matched target</th>
          <th style="width:60px;text-align:right">Count</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>
  </section>`;
}

export function generateLinkFinderReport(summary: LinkFinderSummary): string {
  const byPage = new Map<string, LinkMatch[]>();
  for (const m of summary.matches) {
    if (!byPage.has(m.pageUrl)) byPage.set(m.pageUrl, []);
    byPage.get(m.pageUrl)!.push(m);
  }
  const totalLinks = summary.matches.reduce((n, m) => n + m.occurrences, 0);

  const formattedDate = new Date(summary.generatedAt).toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  const sections = byPage.size > 0
    ? [...byPage.entries()].map(([pageUrl, matches]) => pageSection(pageUrl, matches)).join('\n')
    : `<p class="empty">No pages link to the target URL(s).</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Link Finder Audit</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #202124; padding: 32px; }
    a { color: #1a73e8; text-decoration: none; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .meta { font-size: 13px; color: #5f6368; margin-bottom: 24px; line-height: 1.6; }
    .meta code { font-size: 12px; background: #f1f3f4; padding: 1px 4px; border-radius: 3px; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat { background: #fff; border: 1px solid #dadce0; border-radius: 8px; padding: 16px 24px; min-width: 140px; text-align: center; }
    .stat-number { font-size: 32px; font-weight: 700; color: #1a73e8; }
    .stat-label { font-size: 12px; color: #5f6368; margin-top: 4px; }
    .page { margin-bottom: 24px; }
    .page h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; word-break: break-all; }
    .locale { display: inline-block; font-size: 11px; font-weight: 500; color: #3c4043; background: #e8eaed; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dadce0; border-radius: 8px; overflow: hidden; }
    thead th { background: #f1f3f4; padding: 10px 8px; text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: #3c4043; }
    tbody tr:hover { background: #f8f9fa; }
    .empty { background: #fff; border: 1px solid #dadce0; border-radius: 8px; padding: 24px; text-align: center; color: #5f6368; }
    footer { margin-top: 32px; font-size: 12px; color: #9aa0a6; text-align: center; }
  </style>
</head>
<body>
  <h1>Link Finder Audit</h1>
  <p class="meta">
    <strong>Target URL(s):</strong> ${summary.targetUrls.map((u) => `<code>${esc(u)}</code>`).join(' ')}<br />
    <strong>Locale(s):</strong> ${summary.locales.map(esc).join(', ')} &nbsp;|&nbsp;
    <strong>Generated:</strong> ${formattedDate}
  </p>

  <div class="stats">
    <div class="stat">
      <div class="stat-number">${summary.pagesChecked}</div>
      <div class="stat-label">Pages checked</div>
    </div>
    <div class="stat">
      <div class="stat-number">${byPage.size}</div>
      <div class="stat-label">Pages with links</div>
    </div>
    <div class="stat">
      <div class="stat-number">${totalLinks}</div>
      <div class="stat-label">Matching links</div>
    </div>
  </div>

  ${sections}

  <footer>Generated by KraftHeinz Link Finder Audit · ${formattedDate}</footer>
</body>
</html>`;
}
