import { PageAnalysis, AxeViolation } from './analyzer';

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const IMPACT_ORDER: Record<string, number> = {
  critical: 0, serious: 1, moderate: 2, minor: 3, unknown: 4,
};

const IMPACT_COLOR: Record<string, string> = {
  critical: '#c0392b',
  serious:  '#e67e22',
  moderate: '#d4a017',
  minor:    '#7f8c8d',
  unknown:  '#7f8c8d',
};

function renderAxeViolation(v: AxeViolation): string {
  const color = IMPACT_COLOR[v.impact] ?? IMPACT_COLOR.unknown;
  const nodes = v.nodes.slice(0, 5).map((n) => `
    <li style="margin:6px 0;font-family:monospace;font-size:12px;color:#555">
      <div style="word-break:break-all">${escapeHtml(n.target)}</div>
      ${n.failureSummary ? `<div style="color:#888;margin-top:2px;white-space:pre-wrap">${escapeHtml(n.failureSummary)}</div>` : ''}
    </li>`).join('');
  const overflow = v.nodes.length > 5
    ? `<div style="font-size:11px;color:#aaa;margin-top:4px">…and ${v.nodes.length - 5} more</div>`
    : '';
  return `
    <div style="border-left:4px solid ${color};padding:10px 14px;margin:10px 0;background:#fafafa;border-radius:4px">
      <div style="display:flex;gap:8px;align-items:baseline">
        <span style="background:${color};color:white;border-radius:3px;padding:2px 8px;font-size:11px;font-weight:700;text-transform:uppercase">${escapeHtml(v.impact)}</span>
        <code style="font-size:12px;color:#333">${escapeHtml(v.id)}</code>
        <span style="font-size:12px;color:#666">— ${escapeHtml(v.help)}</span>
        <a href="${escapeHtml(v.helpUrl)}" target="_blank" style="margin-left:auto;font-size:11px;color:#3498db">details ↗</a>
      </div>
      <ul style="margin:8px 0 0 0;padding-left:18px">${nodes}</ul>
      ${overflow}
    </div>`;
}

function renderColorRow(c: { color: string; count: number; samples: string[] }): string {
  const samples = c.samples.length
    ? `<div style="font-size:11px;color:#888;font-family:monospace;margin-left:30px">e.g. ${c.samples.map(escapeHtml).join(', ')}</div>`
    : '';
  return `
    <div style="padding:6px 0;border-bottom:1px solid #f5f5f5">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:20px;height:20px;border-radius:3px;border:1px solid #ddd;background:${escapeHtml(c.color)};flex-shrink:0"></div>
        <code style="font-size:12px;color:#444">${escapeHtml(c.color)}</code>
        <span style="font-size:11px;color:#888">${c.count} element${c.count !== 1 ? 's' : ''}</span>
      </div>
      ${samples}
    </div>`;
}

function renderFontRow(f: { fontFamily: string; fontWeight: number; count: number; samples: string[] }): string {
  const weightLabel = f.fontWeight === 0 ? 'any weight' : `weight ${f.fontWeight}`;
  const samples = f.samples.length
    ? `<div style="font-size:11px;color:#888;font-family:monospace;margin-top:3px">e.g. ${f.samples.map(escapeHtml).join(', ')}</div>`
    : '';
  return `
    <div style="padding:6px 0;border-bottom:1px solid #f5f5f5">
      <div style="display:flex;align-items:center;gap:8px">
        <code style="font-size:12px;color:#444;flex:1">${escapeHtml(f.fontFamily)} <span style="color:#999">· ${escapeHtml(weightLabel)}</span></code>
        <span style="font-size:11px;color:#888">${f.count} element${f.count !== 1 ? 's' : ''}</span>
      </div>
      ${samples}
    </div>`;
}

export interface SinglePageReportContext {
  /** Logical environment label shown in the header — e.g. "production", "preview". */
  environment?: string;
  /** Figma file key used to source the design tokens (or empty if none). */
  figmaFileKey?: string;
}

export function generateSinglePageReport(
  analysis: PageAnalysis,
  context: SinglePageReportContext = {},
): string {
  const ts = new Date(analysis.timestamp).toLocaleString();
  const env = context.environment ?? '—';
  const figma = context.figmaFileKey ?? '—';

  // ── Accessibility summary ─────────────────────────────────────────────
  const axe = [...analysis.axeViolations].sort(
    (a, b) => (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9),
  );
  const counts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  axe.forEach((v) => { counts[v.impact] = (counts[v.impact] ?? 0) + 1; });

  // ── Design token summary ──────────────────────────────────────────────
  const tokens = analysis.designTokenViolations;
  const tokenColorCount = tokens?.unknownColors.length ?? 0;
  const tokenFontCount  = tokens?.unknownFonts.length  ?? 0;
  const totalTokens     = tokenColorCount + tokenFontCount;

  const screenshot = analysis.screenshotBase64
    ? `<img src="data:image/png;base64,${analysis.screenshotBase64}" alt="Page screenshot" style="max-width:100%;border:1px solid #eee;border-radius:6px">`
    : '<p style="color:#aaa">Screenshot unavailable</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Page Analysis — ${escapeHtml(analysis.url)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f5f6f8; color: #222; margin: 0; padding: 24px; }
    .container { max-width: 1100px; margin: 0 auto; }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; border-radius: 12px; padding: 32px; margin-bottom: 24px; }
    .header h1 { margin: 0 0 6px 0; font-size: 22px; }
    .header .url { font-family: monospace; font-size: 13px; opacity: 0.9; word-break: break-all; }
    .meta { display: flex; gap: 18px; margin-top: 14px; font-size: 12px; opacity: 0.75; flex-wrap: wrap; }
    .meta strong { opacity: 1; color: #4ecdc4; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .summary-card { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .summary-card .number { font-size: 28px; font-weight: 700; }
    .summary-card .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .summary-card.danger  .number { color: #c0392b; }
    .summary-card.warning .number { color: #e67e22; }
    .summary-card.ok      .number { color: #27ae60; }
    .section { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 20px; overflow: hidden; }
    .section-header { padding: 14px 20px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px; }
    .section-header h2 { font-size: 15px; margin: 0; flex: 1; }
    .badge { background: #e74c3c; color: white; border-radius: 20px; padding: 2px 10px; font-size: 11px; font-weight: 700; }
    .badge.ok { background: #27ae60; }
    .section-body { padding: 16px 20px; }
    .impact-counts { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .impact-pill { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; color: white; }
    .empty { color: #999; font-style: italic; padding: 8px 0; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Page Analysis Report</h1>
    <div class="url">${escapeHtml(analysis.url)}</div>
    <div class="meta">
      <span>Environment: <strong>${escapeHtml(env)}</strong></span>
      <span>HTTP status: <strong>${analysis.statusCode || '—'}</strong></span>
      <span>Figma file: <strong>${escapeHtml(figma)}</strong></span>
      <span>Generated: <strong>${escapeHtml(ts)}</strong></span>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card ${counts.critical > 0 ? 'danger' : 'ok'}">
      <div class="number">${counts.critical}</div>
      <div class="label">Critical A11y</div>
    </div>
    <div class="summary-card ${counts.serious > 0 ? 'warning' : 'ok'}">
      <div class="number">${counts.serious}</div>
      <div class="label">Serious A11y</div>
    </div>
    <div class="summary-card ${(counts.moderate + counts.minor) > 0 ? 'warning' : 'ok'}">
      <div class="number">${counts.moderate + counts.minor}</div>
      <div class="label">Moderate / Minor A11y</div>
    </div>
    ${tokens !== null ? `
    <div class="summary-card ${tokenColorCount > 0 ? 'warning' : 'ok'}">
      <div class="number">${tokenColorCount}</div>
      <div class="label">Token Colors</div>
    </div>
    <div class="summary-card ${tokenFontCount > 0 ? 'warning' : 'ok'}">
      <div class="number">${tokenFontCount}</div>
      <div class="label">Token Fonts</div>
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-header">
      <h2>📸 Screenshot</h2>
    </div>
    <div class="section-body">${screenshot}</div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>♿ Accessibility Violations</h2>
      <span class="badge ${axe.length === 0 ? 'ok' : ''}">${axe.length} rule${axe.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      ${axe.length === 0
        ? '<p class="empty">✓ No accessibility violations detected by axe-core.</p>'
        : axe.map(renderAxeViolation).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>🎨 Design Token Violations</h2>
      <span class="badge ${totalTokens === 0 ? 'ok' : ''}">${tokens === null ? 'not checked' : `${totalTokens} violation${totalTokens !== 1 ? 's' : ''}`}</span>
    </div>
    <div class="section-body">
      ${tokens === null ? '<p class="empty">Design token check skipped — Figma tokens were not provided.</p>' : `
      <h3 style="font-size:13px;color:#555;margin:0 0 6px 0">Colors</h3>
      <p style="font-size:12px;color:#777;margin:0 0 8px 0">
        ✓ ${tokens.compliantColorCount} compliant &nbsp;·&nbsp;
        <span style="color:#e74c3c">${tokenColorCount} not in palette</span>
      </p>
      ${tokenColorCount === 0
        ? '<p class="empty">All detected colors match the token palette.</p>'
        : tokens.unknownColors.map(renderColorRow).join('')}

      <h3 style="font-size:13px;color:#555;margin:18px 0 6px 0">Fonts</h3>
      <p style="font-size:12px;color:#777;margin:0 0 8px 0">
        ✓ ${tokens.compliantFontCount} compliant &nbsp;·&nbsp;
        <span style="color:#e74c3c">${tokenFontCount} not in token set</span>
      </p>
      ${tokenFontCount === 0
        ? '<p class="empty">All detected fonts match the token set.</p>'
        : tokens.unknownFonts.map(renderFontRow).join('')}
      `}
    </div>
  </div>
</div>
</body>
</html>`;
}
