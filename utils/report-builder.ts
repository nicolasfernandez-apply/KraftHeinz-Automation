import { PageAnalysis, HeadingInfo, ConsoleEntry, AxeViolation, VideoInfo, DesignTokenViolations } from './analyzer';
import { PageDiff, ValueDiff, PerfDiff, SetDiff } from './differ';

// ---- Utility helpers ----

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMs(ms: number): string {
  if (!ms || ms <= 0) return 'N/A';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'N/A';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function headingColor(level: number): string {
  const colors: Record<number, string> = {
    1: '#e74c3c', 2: '#e67e22', 3: '#d4ac0d',
    4: '#27ae60', 5: '#2980b9', 6: '#8e44ad',
  };
  return colors[level] ?? '#95a5a6';
}

function diffIcon(isDifferent: boolean): string {
  return isDifferent
    ? '<span class="icon-diff">≠</span>'
    : '<span class="icon-same">✓</span>';
}

function statusBadge(code: number): string {
  if (!code) return '<em class="empty">—</em>';
  const color = code < 300 ? '#27ae60' : code < 400 ? '#f39c12' : '#e74c3c';
  return `<span class="badge" style="background:${color}">${code}</span>`;
}

function comparisonRow(label: string, diff: ValueDiff<any>, format?: (v: any) => string): string {
  const fmt = (v: any): string => {
    if (format) return format(v);
    if (v === '' || v === null || v === undefined) return '<em class="empty">—</em>';
    return escapeHtml(String(v)).substring(0, 300);
  };
  const cls = diff.isDifferent ? 'diff-row' : 'same-row';
  const cellCls = diff.isDifferent ? 'cell-diff' : 'cell-same';
  return `
    <tr class="${cls}">
      <td class="label-cell">${diffIcon(diff.isDifferent)} ${label}</td>
      <td class="${cellCls}">${fmt(diff.preview)}</td>
      <td class="${cellCls}">${fmt(diff.production)}</td>
    </tr>`;
}

// ---- Section generators ----

function metadataSection(diff: PageDiff): string {
  const diffs = Object.values(diff.metadata).filter((d) => d.isDifferent).length +
    (diff.statusCode.isDifferent ? 1 : 0);

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>🏷️ Page Metadata</h2>
      <span class="badge-count ${diffs === 0 ? 'zero' : ''}">${diffs} diff${diffs !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <table>
        <thead><tr><th>Property</th><th>Preview</th><th>Production</th></tr></thead>
        <tbody>
          ${comparisonRow('HTTP Status', diff.statusCode, (v) => statusBadge(v))}
          ${comparisonRow('URL Path (host excluded)', diff.finalUrlPath)}
          ${comparisonRow('Page Title', diff.metadata.title)}
          ${comparisonRow('Meta Description', diff.metadata.description)}
          ${comparisonRow('Canonical Path (host excluded)', diff.metadata.canonical)}
          ${comparisonRow('OG Title', diff.metadata.ogTitle)}
          ${comparisonRow('OG Description', diff.metadata.ogDescription)}
          ${comparisonRow('OG Image Path (host excluded)', diff.metadata.ogImage)}
          ${comparisonRow('Keywords', diff.metadata.keywords)}
          ${comparisonRow('Robots', diff.metadata.robots)}
          ${comparisonRow('Language', diff.metadata.language)}
          ${comparisonRow('Viewport', diff.metadata.viewport)}
        </tbody>
      </table>
    </div>
  </div>`;
}

function performanceSection(diff: PageDiff): string {
  const WARN_PCT = 20; // highlight if >20% difference

  const perfRow = (label: string, pd: PerfDiff, format: (v: number) => string): string => {
    const abs = Math.abs(pd.deltaPct);
    const isSignificant = abs > WARN_PCT && pd.preview > 0 && pd.production > 0;
    const sign = pd.deltaMs > 0 ? '+' : '';
    const deltaLabel = pd.preview > 0
      ? `<span class="delta ${isSignificant ? 'delta-warn' : 'delta-ok'}">${sign}${pd.deltaMs > 0 ? formatMs(pd.deltaMs) : formatMs(-pd.deltaMs)} ${pd.deltaMs > 0 ? '▲' : '▼'} ${abs}%</span>`
      : '';

    const barPct = (v: number, max: number) => Math.min(100, (v / max) * 100);
    const barColor = (pct: number) => pct < 50 ? '#27ae60' : pct < 80 ? '#f39c12' : '#e74c3c';
    const maxVal = Math.max(pd.preview, pd.production, 1);
    const previewPct = barPct(pd.preview, maxVal);
    const prodPct = barPct(pd.production, maxVal);

    return `
      <tr class="${isSignificant ? 'diff-row' : 'same-row'}">
        <td class="label-cell">${isSignificant ? '<span class="icon-diff">!</span>' : '<span class="icon-same">✓</span>'} ${label}</td>
        <td class="${isSignificant ? 'cell-diff' : 'cell-same'}">
          <div class="perf-bar-wrap">
            <div class="perf-bar"><div class="perf-bar-fill" style="width:${previewPct}%;background:${barColor(previewPct)}"></div></div>
            <span class="perf-value">${format(pd.preview)}</span>
          </div>
        </td>
        <td class="${isSignificant ? 'cell-diff' : 'cell-same'}">
          <div class="perf-bar-wrap">
            <div class="perf-bar"><div class="perf-bar-fill" style="width:${prodPct}%;background:${barColor(prodPct)}"></div></div>
            <span class="perf-value">${format(pd.production)}</span>
          </div>
          ${deltaLabel}
        </td>
      </tr>`;
  };

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>⚡ Performance Metrics</h2>
      <span class="perf-note">Highlighted if &gt;${WARN_PCT}% difference</span>
    </div>
    <div class="section-body">
      <table>
        <thead><tr><th>Metric</th><th>Preview</th><th>Production</th></tr></thead>
        <tbody>
          ${perfRow('Load Time', diff.performance.loadTime, formatMs)}
          ${perfRow('DOM Content Loaded', diff.performance.domContentLoaded, formatMs)}
          ${perfRow('First Contentful Paint', diff.performance.firstContentfulPaint, formatMs)}
          ${perfRow('Response End', diff.performance.responseEnd, formatMs)}
          ${perfRow('Transfer Size', diff.performance.transferSize, formatBytes)}
        </tbody>
      </table>
    </div>
  </div>`;
}

function structureSection(diff: PageDiff): string {
  const structDiffs = [
    diff.headingsCount, diff.imagesCount, diff.linksCount,
    diff.formsCount, diff.scriptsCount, diff.stylesheetsCount,
  ].filter((d) => d.isDifferent).length;

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>🏗️ Page Structure</h2>
      <span class="badge-count ${structDiffs === 0 ? 'zero' : ''}">${structDiffs} diff${structDiffs !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <table>
        <thead><tr><th>Element</th><th>Preview</th><th>Production</th></tr></thead>
        <tbody>
          ${comparisonRow('Headings (H1–H6)', diff.headingsCount)}
          ${comparisonRow('Images', diff.imagesCount)}
          ${comparisonRow('Images Without Alt Text', diff.imagesWithoutAlt)}
          ${comparisonRow('Links', diff.linksCount)}
          ${comparisonRow('Forms', diff.formsCount)}
          ${comparisonRow('Embedded Videos', diff.videosCount)}
          ${comparisonRow('External Scripts', diff.scriptsCount)}
          ${comparisonRow('Stylesheets', diff.stylesheetsCount)}
        </tbody>
      </table>
    </div>
  </div>`;
}

function headingsSection(diff: PageDiff): string {
  const headingDiffs = diff.headings.onlyInPreview.length + diff.headings.onlyInProduction.length;

  const renderHeadings = (headings: HeadingInfo[], onlyHere: HeadingInfo[]): string => {
    if (headings.length === 0) {
      return '<p style="color:#aaa;font-style:italic;padding:8px 0">No headings found</p>';
    }
    const onlyHereKeys = new Set(onlyHere.map((h) => `h${h.level}:${h.text}`));
    return headings
      .map((h) => {
        const isUnique = onlyHereKeys.has(`h${h.level}:${h.text}`);
        return `<div class="heading-item${isUnique ? ' heading-unique' : ''}">
          <span class="heading-tag" style="background:${headingColor(h.level)}">H${h.level}</span>
          <span class="heading-text">${escapeHtml(h.text)}</span>
          ${isUnique ? '<span class="heading-only-tag">Only here</span>' : ''}
        </div>`;
      })
      .join('');
  };

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>📑 Heading Structure</h2>
      <span class="badge-count ${headingDiffs === 0 ? 'zero' : ''}">${headingDiffs} diff${headingDiffs !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <div class="two-col-grid">
        <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
          <div class="pane-title preview-title">Preview (${diff.headings.preview.length} headings)</div>
          ${renderHeadings(diff.headings.preview, diff.headings.onlyInPreview)}
        </div>
        <div class="two-col-pane">
          <div class="pane-title production-title">Production (${diff.headings.production.length} headings)</div>
          ${renderHeadings(diff.headings.production, diff.headings.onlyInProduction)}
        </div>
      </div>
    </div>
  </div>`;
}

function consoleSection(diff: PageDiff, preview: PageAnalysis, production: PageAnalysis): string {
  const totalWarnings = diff.consoleErrors.preview.length + diff.consoleErrors.production.length;

  const renderEntries = (entries: ConsoleEntry[]): string => {
    const filtered = entries.filter((e) => ['error', 'warning'].includes(e.type));
    if (filtered.length === 0) {
      const total = entries.length;
      return `<p class="no-errors">✓ No errors or warnings${total > 0 ? ` (${total} info/log messages not shown)` : ''}</p>`;
    }
    return filtered
      .map(
        (e) => `<div class="console-entry ${e.type}">
        <span class="console-label">${e.type.toUpperCase()}</span>${escapeHtml(e.text)}
      </div>`,
      )
      .join('');
  };

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>🖥️ Console Messages</h2>
      <span class="badge-count ${totalWarnings === 0 ? 'zero' : ''}">${totalWarnings} issue${totalWarnings !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <div class="two-col-grid">
        <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
          <div class="pane-title preview-title">Preview</div>
          ${renderEntries(preview.consoleEntries)}
        </div>
        <div class="two-col-pane">
          <div class="pane-title production-title">Production</div>
          ${renderEntries(production.consoleEntries)}
        </div>
      </div>
    </div>
  </div>`;
}

function imagesSection(diff: PageDiff, preview: PageAnalysis, production: PageAnalysis): string {
  const missingAltDiff = diff.imagesWithoutAlt.isDifferent;

  const renderImages = (images: typeof preview.images): string => {
    if (images.length === 0) return '<p style="color:#aaa;font-style:italic;padding:8px 0">No images found</p>';
    const noAlt = images.filter((i) => !i.hasAlt);
    return `
      <p style="margin-bottom:8px;font-size:13px">Total: <strong>${images.length}</strong> &nbsp;|&nbsp; Missing alt: <strong style="color:${noAlt.length > 0 ? '#e74c3c' : '#27ae60'}">${noAlt.length}</strong></p>
      ${noAlt.length > 0 ? `<div style="margin-top:8px"><p style="font-size:12px;font-weight:600;color:#e74c3c;margin-bottom:4px">Images missing alt text:</p>
        ${noAlt.slice(0, 20).map((img) => `<div class="console-entry error" style="word-break:break-all">${escapeHtml(img.src || '(no src)')}</div>`).join('')}
        ${noAlt.length > 20 ? `<p style="font-size:12px;color:#999">…and ${noAlt.length - 20} more</p>` : ''}
      </div>` : ''}`;
  };

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>🖼️ Images</h2>
      <span class="badge-count ${missingAltDiff ? '' : 'zero'}">${missingAltDiff ? '1 diff' : 'match'}</span>
    </div>
    <div class="section-body">
      <div class="two-col-grid">
        <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
          <div class="pane-title preview-title">Preview</div>
          ${renderImages(preview.images)}
        </div>
        <div class="two-col-pane">
          <div class="pane-title production-title">Production</div>
          ${renderImages(production.images)}
        </div>
      </div>
    </div>
  </div>`;
}

function videoSubSection(d: PageDiff['content']['videos']): string {
  const onlyPreviewSrcs    = new Set(d.onlyInPreview.map((v) => v.src));
  const onlyProductionSrcs = new Set(d.onlyInProduction.map((v) => v.src));
  const uniqueCount = d.onlyInPreview.length + d.onlyInProduction.length;

  // All videos are CDN-hosted native elements — strip the host so preview and
  // production CDN domains don't create false positives in the display.
  const videoPath = (v: VideoInfo): string => {
    try {
      const parsed = new URL(v.src);
      const p = parsed.pathname + parsed.search;
      return p.length > 100 ? p.substring(0, 100) + '…' : p;
    } catch {
      return v.src.length > 100 ? v.src.substring(0, 100) + '…' : v.src;
    }
  };

  const renderCard = (v: VideoInfo, isUnique: boolean): string => `
      <div style="padding:8px 12px;margin-bottom:6px;border-radius:4px;background:${isUnique ? '#fff9f9' : '#fafafa'};border-left:3px solid ${isUnique ? '#e74c3c' : '#e0e0e0'}">
        ${isUnique || v.title ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          ${isUnique ? '<span class="heading-only-tag">Only here</span>' : ''}
          ${v.title ? `<span style="font-size:12px;color:#444">${escapeHtml(v.title)}</span>` : ''}
        </div>` : ''}
        <code style="font-size:11px;color:#777;word-break:break-all;display:block">${escapeHtml(videoPath(v))}</code>
      </div>`;

  const renderSide = (videos: VideoInfo[], onlySrcs: Set<string>): string => {
    if (videos.length === 0) return '<p style="color:#aaa;font-style:italic;padding:8px 0">No videos found</p>';
    return videos.map((v) => renderCard(v, onlySrcs.has(v.src))).join('');
  };

  const header = `
    <div style="padding:12px 20px;background:#fafafa;font-size:13px;font-weight:600;color:#555">
      🎬 Videos
      <span style="font-weight:400;color:#999;margin-left:8px">
        ${uniqueCount} unique &nbsp;·&nbsp; ${d.inBoth.length} in common
      </span>
    </div>`;

  if (d.preview.length === 0 && d.production.length === 0) {
    return `<div style="border-bottom:2px solid #f0f0f0">${header}</div>`;
  }

  return `
    <div style="border-bottom:2px solid #f0f0f0">
      ${header}
      <div style="display:grid;grid-template-columns:1fr 1fr">
        <div style="padding:12px 16px;border-right:1px solid #f0f0f0">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#16a085;background:#e8f8f7;padding:4px 8px;border-radius:3px;display:inline-block;margin-bottom:10px">
            Preview (${d.preview.length})
          </div>
          ${renderSide(d.preview, onlyPreviewSrcs)}
        </div>
        <div style="padding:12px 16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#c0392b;background:#feecec;padding:4px 8px;border-radius:3px;display:inline-block;margin-bottom:10px">
            Production (${d.production.length})
          </div>
          ${renderSide(d.production, onlyProductionSrcs)}
        </div>
      </div>
    </div>`;
}

function contentSection(diff: PageDiff): string {
  const totalDiffs =
    diff.content.text.onlyInPreview.length +
    diff.content.text.onlyInProduction.length +
    diff.content.images.onlyInPreview.length +
    diff.content.images.onlyInProduction.length +
    diff.content.links.onlyInPreview.length +
    diff.content.links.onlyInProduction.length +
    diff.content.videos.onlyInPreview.length +
    diff.content.videos.onlyInProduction.length;

  const MAX = 30; // cap rows per sub-section to keep the report readable

  const renderSetDiff = (d: SetDiff, itemLabel: string, truncate = 120): string => {
    const previewOnly = d.onlyInPreview.slice(0, MAX);
    const prodOnly = d.onlyInProduction.slice(0, MAX);
    const hasMore = d.onlyInPreview.length > MAX || d.onlyInProduction.length > MAX;

    const fmt = (v: string) => escapeHtml(v.length > truncate ? v.substring(0, truncate) + '…' : v);

    const rows = Math.max(previewOnly.length, prodOnly.length);
    if (rows === 0) {
      return `<tr class="same-row">
        <td colspan="2" style="color:#27ae60;padding:12px 16px">
          ✓ All ${d.matchCount} ${itemLabel} match
        </td>
      </tr>`;
    }

    const html: string[] = [];
    for (let i = 0; i < rows; i++) {
      const p = previewOnly[i];
      const q = prodOnly[i];
      html.push(`<tr>
        <td class="${p ? 'cell-diff' : 'cell-same'}" style="vertical-align:top;font-size:13px">${p ? fmt(p) : ''}</td>
        <td class="${q ? 'cell-diff' : 'cell-same'}" style="vertical-align:top;font-size:13px">${q ? fmt(q) : ''}</td>
      </tr>`);
    }

    const moreRow = hasMore
      ? `<tr><td colspan="2" style="color:#999;font-size:12px;padding:8px 16px;font-style:italic">
          …and more (Preview: ${d.onlyInPreview.length} unique, Production: ${d.onlyInProduction.length} unique). Showing first ${MAX} each.
        </td></tr>`
      : '';

    const matchRow = d.matchCount > 0
      ? `<tr><td colspan="2" style="color:#27ae60;font-size:12px;padding:8px 16px">✓ ${d.matchCount} ${itemLabel} in common</td></tr>`
      : '';

    return html.join('') + moreRow + matchRow;
  };

  const subSection = (title: string, icon: string, d: SetDiff, itemLabel: string, truncate?: number): string => `
    <div style="border-bottom:2px solid #f0f0f0;margin-bottom:0">
      <div style="padding:12px 20px;background:#fafafa;font-size:13px;font-weight:600;color:#555">
        ${icon} ${title}
        <span style="font-weight:400;color:#999;margin-left:8px">
          ${d.onlyInPreview.length + d.onlyInProduction.length} unique items
          &nbsp;·&nbsp; ${d.matchCount} in common
        </span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="background:#e8f8f7;color:#16a085;padding:8px 16px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;width:50%">
              Only in Preview (${d.onlyInPreview.length})
            </th>
            <th style="background:#feecec;color:#c0392b;padding:8px 16px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;width:50%">
              Only in Production (${d.onlyInProduction.length})
            </th>
          </tr>
        </thead>
        <tbody>${renderSetDiff(d, itemLabel, truncate)}</tbody>
      </table>
    </div>`;

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>📄 Content Comparison</h2>
      <span class="badge-count ${totalDiffs === 0 ? 'zero' : ''}">${totalDiffs} unique item${totalDiffs !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      ${subSection('Text Content', '📝', diff.content.text, 'text blocks', 200)}
      ${subSection('Images (by path)', '🖼️', diff.content.images, 'images', 120)}
      ${subSection('Links (by path)', '🔗', diff.content.links, 'links', 120)}
      ${videoSubSection(diff.content.videos)}
    </div>
  </div>`;
}

function accessibilitySection(diff: PageDiff): string {
  const total = diff.axe.preview.length + diff.axe.production.length;

  const IMPACT_STYLE: Record<string, { bg: string; border: string; color: string }> = {
    critical: { bg: '#fde8e8', border: '#c0392b', color: '#c0392b' },
    serious:  { bg: '#fef3e2', border: '#d35400', color: '#d35400' },
    moderate: { bg: '#fefbd8', border: '#b7791f', color: '#b7791f' },
    minor:    { bg: '#f0f0f0', border: '#888',    color: '#666'    },
  };

  const IMPACT_ORDER: Record<string, number> = {
    critical: 0, serious: 1, moderate: 2, minor: 3,
  };

  const sortByImpact = (violations: AxeViolation[]) =>
    [...violations].sort(
      (a, b) => (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4),
    );

  const MAX_NODES = 5;

  const renderNodes = (nodes: AxeViolation['nodes']): string => {
    const shown = nodes.slice(0, MAX_NODES);
    const rest  = nodes.length - shown.length;
    const rows  = shown.map((n) => {
      const html    = n.html.length > 250 ? n.html.substring(0, 250) + '…' : n.html;
      // failureSummary can be multi-line; keep first two lines to stay compact
      const summary = n.failureSummary.split('\n').slice(0, 2).join(' ').trim();
      return `
          <div class="axe-node">
            <code class="axe-selector">${escapeHtml(n.target)}</code>
            <code class="axe-html-snippet">${escapeHtml(html)}</code>
            ${summary ? `<span class="axe-failure">${escapeHtml(summary)}</span>` : ''}
          </div>`;
    }).join('');
    const moreRow = rest > 0 ? `<div class="axe-more">…and ${rest} more element${rest !== 1 ? 's' : ''}</div>` : '';
    return `<div class="axe-nodes-list">${rows}${moreRow}</div>`;
  };

  const renderViolations = (violations: AxeViolation[], uniqueIds: Set<string>): string => {
    if (violations.length === 0) {
      return '<p class="no-errors">✓ No violations found</p>';
    }
    return sortByImpact(violations).map((v) => {
      const style   = IMPACT_STYLE[v.impact] ?? IMPACT_STYLE.minor;
      const isUnique = uniqueIds.has(v.id);
      const count   = v.nodes.length;
      return `
        <div class="axe-violation${isUnique ? ' axe-unique' : ''}" style="border-left-color:${style.border}">
          <div class="axe-header">
            <span class="axe-impact" style="background:${style.bg};color:${style.color}">${escapeHtml(v.impact)}</span>
            <a class="axe-id" href="${escapeHtml(v.helpUrl)}" target="_blank">${escapeHtml(v.id)}</a>
            ${isUnique ? '<span class="heading-only-tag">Only here</span>' : ''}
            <span class="axe-nodes-count">${count} element${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="axe-help">${escapeHtml(v.help)}</div>
          ${renderNodes(v.nodes)}
        </div>`;
    }).join('');
  };

  const previewUniqueIds    = new Set(diff.axe.onlyInPreview.map((v) => v.id));
  const productionUniqueIds = new Set(diff.axe.onlyInProduction.map((v) => v.id));

  const inBothNote = diff.axe.inBoth.length > 0
    ? `<div style="padding:10px 20px;background:#fafafa;border-top:1px solid #f0f0f0;font-size:12px;color:#888">
        ${diff.axe.inBoth.length} rule${diff.axe.inBoth.length !== 1 ? 's' : ''} with violations on both sides:
        ${diff.axe.inBoth.map((id) => `<code style="font-size:11px">${escapeHtml(id)}</code>`).join(', ')}
       </div>`
    : '';

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>♿ Accessibility (axe-core)</h2>
      <span class="badge-count ${total === 0 ? 'zero' : ''}">${total} violation${total !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <div class="two-col-grid">
        <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
          <div class="pane-title preview-title">Preview (${diff.axe.preview.length} violation${diff.axe.preview.length !== 1 ? 's' : ''})</div>
          ${renderViolations(diff.axe.preview, previewUniqueIds)}
        </div>
        <div class="two-col-pane">
          <div class="pane-title production-title">Production (${diff.axe.production.length} violation${diff.axe.production.length !== 1 ? 's' : ''})</div>
          ${renderViolations(diff.axe.production, productionUniqueIds)}
        </div>
      </div>
      ${inBothNote}
    </div>
  </div>`;
}

function designTokensSection(diff: PageDiff): string {
  if (!diff.designTokens) return '';

  const { preview, production, colorsOnlyInPreview, colorsOnlyInProduction,
          colorsInBoth, fontsOnlyInPreview, fontsOnlyInProduction, fontsInBoth } = diff.designTokens;

  const totalUnknownColors =
    (preview?.unknownColors.length  ?? 0) + (production?.unknownColors.length ?? 0);
  const totalUnknownFonts =
    (preview?.unknownFonts.length   ?? 0) + (production?.unknownFonts.length  ?? 0);
  const totalViolations = totalUnknownColors + totalUnknownFonts;

  /** Render one side's color violations as a swatch grid. */
  const renderColors = (violations: DesignTokenViolations | null, onlyHere: string[], inBoth: string[]): string => {
    if (!violations) return '<p style="color:#aaa;font-style:italic;padding:8px 0">Not analysed</p>';
    const compliant = violations.compliantColorCount;
    const unknown   = violations.unknownColors;
    if (unknown.length === 0) {
      return `<p class="no-errors">✓ All ${compliant} detected color${compliant !== 1 ? 's' : ''} match the design token palette</p>`;
    }
    const swatches = unknown.map((c) => {
      const isUnique = onlyHere.includes(c.color);
      const shared   = inBoth.includes(c.color);
      const border   = isUnique ? '#e74c3c' : shared ? '#f39c12' : '#ddd';
      const label    = isUnique ? 'only here' : shared ? 'both sides' : '';
      const props    = c.properties.join(', ').replace(/([A-Z])/g, ' $1').toLowerCase();
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f5f5f5">
          <div style="width:20px;height:20px;border-radius:3px;border:2px solid ${escapeHtml(border)};background:${escapeHtml(c.color)};flex-shrink:0"></div>
          <code style="font-size:12px;color:#444;min-width:70px">${escapeHtml(c.color)}</code>
          <span style="font-size:11px;color:#888">${c.count} element${c.count !== 1 ? 's' : ''} · ${escapeHtml(props)}</span>
          ${label ? `<span class="heading-only-tag" style="margin-left:auto">${escapeHtml(label)}</span>` : ''}
        </div>`;
    }).join('');
    return `
      <p style="font-size:12px;color:#555;margin-bottom:8px">
        ✓ <strong>${compliant}</strong> token-compliant color${compliant !== 1 ? 's' : ''} &nbsp;·&nbsp;
        <span style="color:#e74c3c"><strong>${unknown.length}</strong> not in token palette</span>
      </p>
      ${swatches}`;
  };

  /** Render one side's font violations. */
  const renderFonts = (violations: DesignTokenViolations | null, onlyHere: string[], inBoth: string[]): string => {
    if (!violations) return '<p style="color:#aaa;font-style:italic;padding:8px 0">Not analysed</p>';
    const compliant = violations.compliantFontCount;
    const unknown   = violations.unknownFonts;
    if (unknown.length === 0) {
      return `<p class="no-errors">✓ All ${compliant} detected font${compliant !== 1 ? 's' : ''} match the design token set</p>`;
    }
    const rows = unknown.map((f) => {
      const isUnique = onlyHere.includes(f.fontFamily);
      const shared   = inBoth.includes(f.fontFamily);
      const label    = isUnique ? 'only here' : shared ? 'both sides' : '';
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f5f5f5">
          <code style="font-size:12px;color:#444;flex:1">${escapeHtml(f.fontFamily)}</code>
          <span style="font-size:11px;color:#888">${f.count} element${f.count !== 1 ? 's' : ''}</span>
          ${label ? `<span class="heading-only-tag">${escapeHtml(label)}</span>` : ''}
        </div>`;
    }).join('');
    return `
      <p style="font-size:12px;color:#555;margin-bottom:8px">
        ✓ <strong>${compliant}</strong> token-compliant font${compliant !== 1 ? 's' : ''} &nbsp;·&nbsp;
        <span style="color:#e74c3c"><strong>${unknown.length}</strong> not in token set</span>
      </p>
      ${rows}`;
  };

  const crossEnvNote = (colorsOnlyInPreview.length + colorsOnlyInProduction.length +
                        fontsOnlyInPreview.length  + fontsOnlyInProduction.length) > 0
    ? `<div style="padding:10px 20px;background:#fffde7;border-top:1px solid #f0f0f0;font-size:12px;color:#856404">
        ⚠ Some violations appear on only one environment:
        ${colorsOnlyInPreview.length  ? `${colorsOnlyInPreview.length} color${colorsOnlyInPreview.length !== 1 ? 's' : ''} only on Preview` : ''}
        ${colorsOnlyInProduction.length ? `${colorsOnlyInProduction.length} color${colorsOnlyInProduction.length !== 1 ? 's' : ''} only on Production` : ''}
        ${fontsOnlyInPreview.length   ? `${fontsOnlyInPreview.length} font${fontsOnlyInPreview.length !== 1 ? 's' : ''} only on Preview` : ''}
        ${fontsOnlyInProduction.length ? `${fontsOnlyInProduction.length} font${fontsOnlyInProduction.length !== 1 ? 's' : ''} only on Production` : ''}
        &nbsp;(highlighted in red swatches above)
       </div>`
    : '';

  return `
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>🎨 Design Token Compliance</h2>
      <span class="badge-count ${totalViolations === 0 ? 'zero' : ''}">${totalViolations} violation${totalViolations !== 1 ? 's' : ''}</span>
    </div>
    <div class="section-body">
      <!-- Colors -->
      <div style="border-bottom:2px solid #f0f0f0">
        <div style="padding:12px 20px;background:#fafafa;font-size:13px;font-weight:600;color:#555">
          🎨 Colors
          <span style="font-weight:400;color:#999;margin-left:8px">
            ${colorsInBoth.length} violation${colorsInBoth.length !== 1 ? 's' : ''} on both sides
            &nbsp;·&nbsp; ${colorsOnlyInPreview.length + colorsOnlyInProduction.length} environment-specific
          </span>
        </div>
        <div class="two-col-grid">
          <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
            <div class="pane-title preview-title">Preview</div>
            ${renderColors(preview, colorsOnlyInPreview, colorsInBoth)}
          </div>
          <div class="two-col-pane">
            <div class="pane-title production-title">Production</div>
            ${renderColors(production, colorsOnlyInProduction, colorsInBoth)}
          </div>
        </div>
      </div>
      <!-- Fonts -->
      <div>
        <div style="padding:12px 20px;background:#fafafa;font-size:13px;font-weight:600;color:#555">
          🔤 Font Families
          <span style="font-weight:400;color:#999;margin-left:8px">
            ${fontsInBoth.length} violation${fontsInBoth.length !== 1 ? 's' : ''} on both sides
            &nbsp;·&nbsp; ${fontsOnlyInPreview.length + fontsOnlyInProduction.length} environment-specific
          </span>
        </div>
        <div class="two-col-grid">
          <div class="two-col-pane" style="border-right:1px solid #f0f0f0">
            <div class="pane-title preview-title">Preview</div>
            ${renderFonts(preview, fontsOnlyInPreview, fontsInBoth)}
          </div>
          <div class="two-col-pane">
            <div class="pane-title production-title">Production</div>
            ${renderFonts(production, fontsOnlyInProduction, fontsInBoth)}
          </div>
        </div>
      </div>
      ${crossEnvNote}
    </div>
  </div>`;
}

// ---- CSS ----

function getStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; line-height: 1.6; font-size: 14px; }
    a { color: #4a90e2; text-decoration: none; }
    a:hover { text-decoration: underline; }
    em.empty { color: #bbb; font-style: italic; }

    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }

    /* Header */
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; border-radius: 12px; padding: 40px; margin-bottom: 24px; }
    .header h1 { font-size: 26px; font-weight: 700; margin-bottom: 4px; }
    .header .subtitle { opacity: 0.65; font-size: 13px; margin-bottom: 24px; }
    .url-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .url-card { background: rgba(255,255,255,0.1); border-radius: 8px; padding: 16px; }
    .url-card .env-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; opacity: 0.6; margin-bottom: 6px; }
    .url-card .env-url { font-family: monospace; font-size: 13px; word-break: break-all; }
    .url-card.preview { border-left: 3px solid #4ecdc4; }
    .url-card.production { border-left: 3px solid #ff6b6b; }

    /* Summary */
    .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-bottom: 24px; }
    .summary-card { background: white; border-radius: 10px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.07); }
    .summary-card .number { font-size: 38px; font-weight: 700; line-height: 1; }
    .summary-card .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-top: 6px; }
    .summary-card.danger .number { color: #e74c3c; }
    .summary-card.warning .number { color: #f39c12; }
    .summary-card.success .number { color: #27ae60; }
    .summary-card.info .number { color: #2980b9; }

    /* Sections */
    .section { background: white; border-radius: 10px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.07); overflow: hidden; }
    .section-header { padding: 16px 20px; cursor: pointer; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #f0f0f0; user-select: none; }
    .section-header:hover { background: #fafafa; }
    .section-header h2 { font-size: 15px; font-weight: 600; flex: 1; }
    .badge-count { background: #e74c3c; color: white; border-radius: 20px; padding: 2px 10px; font-size: 11px; font-weight: 700; }
    .badge-count.zero { background: #27ae60; }
    .perf-note { font-size: 11px; color: #aaa; }
    .toggle { font-size: 16px; color: #bbb; transition: transform 0.2s; display: inline-block; }
    .section-header.collapsed .toggle { transform: rotate(-90deg); }
    .section-body.collapsed { display: none; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fa; padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #777; border-bottom: 2px solid #e9ecef; }
    td { padding: 11px 16px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .label-cell { font-weight: 500; width: 210px; white-space: nowrap; color: #555; }
    .diff-row { background: #fff9f9; }
    .same-row { background: white; }
    .cell-diff { color: #c0392b; background: #fef5f5; }
    .cell-same { color: #333; }
    .icon-diff { color: #e74c3c; font-weight: 700; margin-right: 5px; }
    .icon-same { color: #27ae60; font-weight: 700; margin-right: 5px; }

    /* Screenshots */
    .screenshot-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .screenshot-pane { padding: 20px; }
    .screenshot-pane img { width: 100%; border: 1px solid #e0e0e0; border-radius: 6px; cursor: zoom-in; transition: box-shadow 0.2s; }
    .screenshot-pane img:hover { box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
    .pane-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; padding: 5px 10px; border-radius: 4px; display: inline-block; }
    .preview-title { background: #e8f8f7; color: #16a085; }
    .production-title { background: #feecec; color: #c0392b; }

    /* Two-col layout */
    .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .two-col-pane { padding: 16px 20px; }

    /* Headings */
    .heading-item { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; border-bottom: 1px solid #fafafa; }
    .heading-item.heading-unique { background: #fff9f9; border-radius: 4px; padding: 5px 8px; margin: 2px 0; }
    .heading-tag { font-size: 10px; font-weight: 700; color: white; padding: 2px 6px; border-radius: 3px; flex-shrink: 0; margin-top: 2px; }
    .heading-text { font-size: 13px; color: #333; flex: 1; }
    .heading-unique .heading-text { color: #c0392b; }
    .heading-only-tag { font-size: 10px; color: #e74c3c; font-weight: 700; flex-shrink: 0; padding: 2px 6px; background: #ffeaea; border-radius: 3px; }

    /* Console */
    .console-entry { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; padding: 6px 10px; border-radius: 4px; margin-bottom: 4px; word-break: break-word; }
    .console-entry.error { background: #ffeaea; color: #c0392b; border-left: 3px solid #e74c3c; }
    .console-entry.warning { background: #fffde7; color: #b7791f; border-left: 3px solid #f39c12; }
    .console-label { font-weight: 700; margin-right: 8px; font-size: 10px; }
    .no-errors { color: #27ae60; font-size: 13px; padding: 6px 0; }

    /* Performance */
    .perf-bar-wrap { display: flex; align-items: center; gap: 8px; }
    .perf-bar { flex: 1; max-width: 180px; height: 6px; background: #f0f0f0; border-radius: 3px; overflow: hidden; }
    .perf-bar-fill { height: 100%; border-radius: 3px; }
    .perf-value { font-family: monospace; font-size: 13px; white-space: nowrap; }
    .delta { font-size: 11px; display: block; margin-top: 3px; padding: 2px 6px; border-radius: 3px; width: fit-content; }
    .delta-warn { background: #fff3cd; color: #856404; }
    .delta-ok { background: #d4edda; color: #155724; }

    /* Accessibility */
    .axe-violation { padding: 8px 12px; margin-bottom: 6px; border-radius: 4px; background: #fafafa; border-left: 3px solid #ccc; }
    .axe-violation.axe-unique { background: #fff9f9; }
    .axe-header { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap; }
    .axe-impact { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; }
    .axe-id { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; color: #2980b9; }
    .axe-nodes-count { font-size: 11px; color: #999; margin-left: auto; white-space: nowrap; }
    .axe-help { font-size: 12px; color: #555; margin-bottom: 6px; }
    .axe-nodes-list { margin-top: 6px; display: flex; flex-direction: column; gap: 5px; }
    .axe-node { background: #fff; border: 1px solid #e8e8e8; border-radius: 4px; padding: 7px 10px; font-size: 12px; }
    .axe-selector { display: block; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; color: #555; margin-bottom: 4px; word-break: break-all; }
    .axe-selector::before { content: '▸ '; color: #aaa; }
    .axe-html-snippet { display: block; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 11px; background: #f5f5f5; padding: 4px 8px; border-radius: 3px; white-space: pre-wrap; word-break: break-all; color: #333; margin-bottom: 4px; }
    .axe-failure { font-size: 11px; color: #888; white-space: pre-wrap; }
    .axe-more { font-size: 11px; color: #aaa; font-style: italic; padding: 4px 0; }

    /* Misc */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; color: white; }
    .footer { text-align: center; color: #bbb; font-size: 12px; padding: 32px 24px; }

    @media (max-width: 1100px) {
      .summary-grid { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 900px) {
      .summary-grid { grid-template-columns: 1fr 1fr; }
      .url-grid, .screenshot-grid, .two-col-grid { grid-template-columns: 1fr; }
    }
  `;
}

// ---- Main export ----

export function generateReport(
  preview: PageAnalysis,
  production: PageAnalysis,
  diff: PageDiff,
): string {
  const timestamp = new Date().toLocaleString();
  const totalDiffs = diff.totalDifferences;
  const criticalDiffs = diff.criticalDifferences;
  const previewErrors = diff.consoleErrors.preview.length;
  const productionErrors = diff.consoleErrors.production.length;
  const axeTotal = diff.axe.preview.length + diff.axe.production.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>URL Comparison Report — ${timestamp}</title>
  <style>${getStyles()}</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <h1>URL Comparison Report</h1>
    <p class="subtitle">Generated on ${timestamp}</p>
    <div class="url-grid">
      <div class="url-card preview">
        <div class="env-label">Preview</div>
        <div class="env-url"><a href="${escapeHtml(preview.url)}" style="color:#4ecdc4" target="_blank">${escapeHtml(preview.url)}</a></div>
      </div>
      <div class="url-card production">
        <div class="env-label">Production</div>
        <div class="env-url"><a href="${escapeHtml(production.url)}" style="color:#ff6b6b" target="_blank">${escapeHtml(production.url)}</a></div>
      </div>
    </div>
  </div>

  <!-- Summary Cards -->
  <div class="summary-grid">
    <div class="summary-card ${totalDiffs > 0 ? 'danger' : 'success'}">
      <div class="number">${totalDiffs}</div>
      <div class="label">Total Differences</div>
    </div>
    <div class="summary-card ${criticalDiffs > 0 ? 'danger' : 'success'}">
      <div class="number">${criticalDiffs}</div>
      <div class="label">Critical Differences</div>
    </div>
    <div class="summary-card ${previewErrors > 0 ? 'warning' : 'success'}">
      <div class="number">${previewErrors}</div>
      <div class="label">Preview Issues</div>
    </div>
    <div class="summary-card ${productionErrors > 0 ? 'warning' : 'success'}">
      <div class="number">${productionErrors}</div>
      <div class="label">Production Issues</div>
    </div>
    <div class="summary-card ${axeTotal > 0 ? 'warning' : 'success'}">
      <div class="number">${axeTotal}</div>
      <div class="label">A11y Violations</div>
    </div>
  </div>

  <!-- Screenshots -->
  <div class="section">
    <div class="section-header" onclick="toggleSection(this)">
      <span class="toggle">▼</span>
      <h2>📸 Screenshots</h2>
    </div>
    <div class="section-body">
      <div class="screenshot-grid">
        <div class="screenshot-pane" style="border-right:1px solid #f0f0f0">
          <div class="pane-title preview-title">Preview</div>
          ${preview.screenshotBase64
            ? `<img src="data:image/png;base64,${preview.screenshotBase64}" alt="Preview screenshot">`
            : '<p style="color:#bbb">Screenshot not available</p>'}
        </div>
        <div class="screenshot-pane">
          <div class="pane-title production-title">Production</div>
          ${production.screenshotBase64
            ? `<img src="data:image/png;base64,${production.screenshotBase64}" alt="Production screenshot">`
            : '<p style="color:#bbb">Screenshot not available</p>'}
        </div>
      </div>
    </div>
  </div>

  ${metadataSection(diff)}
  ${performanceSection(diff)}
  ${structureSection(diff)}
  ${headingsSection(diff)}
  ${imagesSection(diff, preview, production)}
  ${contentSection(diff)}
  ${accessibilitySection(diff)}
  ${designTokensSection(diff)}
  ${consoleSection(diff, preview, production)}

  <div class="footer">
    Generated by KraftHeinz URL Comparison Tool &nbsp;•&nbsp; ${timestamp}
  </div>
</div>

<script>
  function toggleSection(header) {
    header.classList.toggle('collapsed');
    header.nextElementSibling.classList.toggle('collapsed');
  }
</script>
</body>
</html>`;
}
