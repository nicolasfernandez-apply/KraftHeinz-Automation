import { FormScanResult, FormField } from './form-analyzer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FieldValidationResult {
  field: string;
  selector: string;
  value: string;
  reason: string;
  errorVisible: boolean;
  errorText: string;
}

/** A single value that was loaded into the form for a valid submission. */
export interface SubmittedFieldValue {
  field: string;
  type: string;
  /** Human-readable value applied to the field (e.g. "checked", "jane@doe.com"). */
  value: string;
}

/** A backend request captured during a valid submission (for manual validation). */
export interface BackendRequestInfo {
  url: string;
  method: string;
  contentType: string;
  /** Formatted request body (pretty-printed JSON when possible, else raw). */
  payload: string;
  /** Campaign name extracted from the payload, if one was found. */
  campaignName?: string;
}

export interface FormScenarioResult {
  scenario: 'valid-submission' | 'required-empty' | 'invalid-data';
  label: string;
  passed: boolean;
  message: string;
  screenshotBase64?: string;
  fieldResults?: FieldValidationResult[];
  /** Data loaded into the form for this valid scenario. */
  submittedData?: SubmittedFieldValue[];
  /** POST/PUT/PATCH requests captured when this valid scenario was submitted. */
  backendRequests?: BackendRequestInfo[];
}

export interface FormReportData {
  entryName: string;
  url: string;
  environment: string;
  pageTitle: string;
  scanResult: FormScanResult;
  scenarios: FormScenarioResult[];
  generatedAt: string;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(text: string, ok: boolean): string {
  const cls = ok ? 'badge-pass' : 'badge-fail';
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function fieldTypeLabel(type: string): string {
  const map: Record<string, string> = {
    text: 'Text', email: 'Email', tel: 'Phone', number: 'Number',
    password: 'Password', select: 'Dropdown', textarea: 'Textarea',
    checkbox: 'Checkbox', radio: 'Radio', date: 'Date', url: 'URL',
    file: 'File Upload',
  };
  return map[type] ?? type;
}

function renderFields(fields: FormField[]): string {
  if (fields.length === 0) return '<p class="muted">No fields detected.</p>';
  const rows = fields.map((f) => `
    <tr>
      <td>${esc(f.label || f.name || f.id || '—')}</td>
      <td><code>${esc(fieldTypeLabel(f.type))}</code></td>
      <td>${f.required ? badge('Required', false) : '<span class="muted">Optional</span>'}</td>
      <td><code>${esc(f.selector)}</code></td>
      <td class="test-data">
        <span class="valid-val">✓ ${esc(f.testData?.valid ?? '—')}</span>
        ${(f.testData?.invalid ?? []).map((iv) =>
          `<span class="invalid-val">✗ ${esc(iv.value || '(empty)')} — ${esc(iv.reason)}</span>`
        ).join('')}
      </td>
    </tr>`).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Label</th><th>Type</th><th>Required</th><th>Selector</th><th>Test Data</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderScenario(s: FormScenarioResult): string {
  const statusIcon = s.passed ? '✅' : '❌';
  const statusClass = s.passed ? 'pass' : 'fail';

  const screenshot = s.screenshotBase64
    ? `<div class="screenshot-wrap">
        <img src="data:image/png;base64,${s.screenshotBase64}" alt="Screenshot after ${esc(s.label)}" />
       </div>`
    : '';

  const fieldTable =
    s.fieldResults && s.fieldResults.length > 0
      ? `<table class="field-results">
          <thead><tr><th>Field</th><th>Value</th><th>Reason</th><th>Error Visible</th><th>Error Text</th></tr></thead>
          <tbody>
            ${s.fieldResults.map((r) => `
              <tr class="${r.errorVisible ? 'row-pass' : 'row-fail'}">
                <td>${esc(r.field)}</td>
                <td><code>${esc(r.value || '(empty)')}</code></td>
                <td>${esc(r.reason)}</td>
                <td>${r.errorVisible ? badge('Visible', true) : badge('Not Found', false)}</td>
                <td class="muted">${esc(r.errorText || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
      : '';

  // Data loaded into the form for a valid submission — lets a reviewer
  // reproduce the exact input on another platform.
  const submittedTable =
    s.submittedData && s.submittedData.length > 0
      ? `<h4 class="sub-head">Data loaded in the form</h4>
         <table class="submitted-data">
          <thead><tr><th>Field</th><th>Type</th><th>Value</th></tr></thead>
          <tbody>
            ${s.submittedData.map((d) => `
              <tr>
                <td>${esc(d.field || '—')}</td>
                <td><code>${esc(fieldTypeLabel(d.type))}</code></td>
                <td><code>${esc(d.value || '(empty)')}</code></td>
              </tr>`).join('')}
          </tbody>
        </table>`
      : '';

  // Backend request(s) — campaign name is highlighted for manual validation.
  const backendBlock =
    s.backendRequests && s.backendRequests.length > 0
      ? `<h4 class="sub-head">Backend request${s.backendRequests.length > 1 ? 's' : ''}</h4>
         ${s.backendRequests.map((r) => `
          <div class="backend-req">
            <div class="backend-meta">
              <span class="method">${esc(r.method)}</span>
              <code class="req-url">${esc(r.url)}</code>
            </div>
            ${r.campaignName
              ? `<p class="campaign"><span class="campaign-lbl">Campaign name:</span> <strong>${esc(r.campaignName)}</strong></p>`
              : '<p class="campaign muted">No campaign field found in this request.</p>'}
            <pre class="payload">${esc(r.payload)}</pre>
          </div>`).join('')}`
      : (s.scenario === 'valid-submission'
          ? '<h4 class="sub-head">Backend request</h4><p class="muted">No POST/PUT/PATCH request was captured on submit (the form may submit via a full page navigation or was blocked by bot protection).</p>'
          : '');

  return `
    <details class="scenario ${statusClass}" open>
      <summary>${statusIcon} ${esc(s.label)}</summary>
      <div class="scenario-body">
        ${s.message ? `<p class="scenario-msg">${esc(s.message)}</p>` : ''}
        ${submittedTable}
        ${backendBlock}
        ${fieldTable}
        ${screenshot}
      </div>
    </details>`;
}

export function generateFormReport(data: FormReportData): string {
  const totalScenarios = data.scenarios.length;
  const passedScenarios = data.scenarios.filter((s) => s.passed).length;
  const totalForms = data.scanResult.forms.length;
  const totalFields = data.scanResult.forms.reduce((n, f) => n + f.fields.length, 0);
  const requiredFields = data.scanResult.forms.reduce(
    (n, f) => n + f.fields.filter((fld) => fld.required).length,
    0,
  );

  const overallPassed = passedScenarios === totalScenarios;
  const envLabel = data.environment === 'preview' ? '🔒 Preview' : '🌐 Production';

  const formSections = data.scanResult.forms.map((form, i) => `
    <section class="form-section">
      <h3>Form ${i + 1}${form.action ? ` — <code>${esc(form.action)}</code>` : ''}</h3>
      <div class="meta-grid">
        <span>Method: <strong>${esc((form.method ?? 'get').toUpperCase())}</strong></span>
        <span>Fields: <strong>${form.fields.length}</strong></span>
        <span>Required: <strong>${form.fields.filter((f) => f.required).length}</strong></span>
      </div>
      ${renderFields(form.fields)}
    </section>`).join('');

  const scenarioSections = data.scenarios.map(renderScenario).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Form Test Report — ${esc(data.entryName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #1a1a1a; background: #f5f5f5; }
    header { background: #c8102e; color: #fff; padding: 24px 32px; }
    header h1 { font-size: 22px; font-weight: 700; }
    header .sub { font-size: 13px; opacity: .85; margin-top: 4px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px 32px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; }
    .card .num { font-size: 28px; font-weight: 700; }
    .card .lbl { font-size: 12px; color: #666; margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }
    .card.green .num { color: #16a34a; }
    .card.red .num { color: #dc2626; }
    .card.blue .num { color: #2563eb; }
    section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
    h2 { font-size: 16px; font-weight: 700; margin-bottom: 14px; border-bottom: 1px solid #e0e0e0; padding-bottom: 10px; }
    h3 { font-size: 14px; font-weight: 700; margin-bottom: 10px; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f9f9f9; text-align: left; padding: 8px 10px; border-bottom: 2px solid #e0e0e0; font-weight: 600; white-space: nowrap; }
    td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    code { background: #f3f3f3; border-radius: 3px; padding: 1px 5px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
    .badge-pass { background: #dcfce7; color: #166534; }
    .badge-fail { background: #fee2e2; color: #991b1b; }
    .muted { color: #999; font-size: 12px; }
    .test-data { line-height: 1.8; }
    .valid-val { display: block; color: #16a34a; font-size: 12px; }
    .invalid-val { display: block; color: #dc2626; font-size: 12px; }
    .meta-grid { display: flex; gap: 20px; margin-bottom: 12px; font-size: 13px; color: #555; }
    details.scenario { border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
    details.scenario summary { padding: 12px 16px; font-weight: 600; cursor: pointer; background: #fafafa; font-size: 14px; list-style: none; display: flex; align-items: center; gap: 8px; }
    details.scenario summary::-webkit-details-marker { display: none; }
    details.scenario.pass > summary { background: #f0fdf4; border-left: 4px solid #16a34a; }
    details.scenario.fail > summary { background: #fef2f2; border-left: 4px solid #dc2626; }
    .scenario-body { padding: 16px; border-top: 1px solid #e0e0e0; }
    .scenario-msg { color: #555; margin-bottom: 12px; font-size: 13px; }
    .field-results .row-pass td { background: #f0fdf4; }
    .field-results .row-fail td { background: #fef2f2; }
    .sub-head { font-size: 13px; font-weight: 700; color: #333; margin: 16px 0 8px; }
    .submitted-data code { font-size: 12px; }
    .backend-req { border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; background: #fbfbfb; }
    .backend-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .backend-meta .method { display: inline-block; background: #2563eb; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; letter-spacing: .03em; }
    .backend-meta .req-url { font-size: 12px; word-break: break-all; }
    .campaign { font-size: 13px; margin-bottom: 8px; }
    .campaign .campaign-lbl { color: #555; }
    .campaign strong { background: #fef9c3; padding: 1px 6px; border-radius: 3px; color: #713f12; }
    pre.payload { background: #1a1a1a; color: #e5e5e5; border-radius: 6px; padding: 12px 14px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow-y: auto; }
    .screenshot-wrap { margin-top: 12px; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; }
    .screenshot-wrap img { width: 100%; display: block; }
    .form-section { margin-bottom: 16px; }
    .overall-pass { color: #16a34a; }
    .overall-fail { color: #dc2626; }
  </style>
</head>
<body>
  <header>
    <h1>Form Test Report — ${esc(data.entryName)}</h1>
    <div class="sub">${envLabel} &nbsp;·&nbsp; ${esc(data.url)} &nbsp;·&nbsp; ${data.generatedAt}</div>
  </header>

  <div class="container">

    <div class="summary-grid">
      <div class="card ${overallPassed ? 'green' : 'red'}">
        <div class="num">${passedScenarios}/${totalScenarios}</div>
        <div class="lbl">Scenarios Passed</div>
      </div>
      <div class="card blue">
        <div class="num">${totalForms}</div>
        <div class="lbl">Forms Found</div>
      </div>
      <div class="card blue">
        <div class="num">${totalFields}</div>
        <div class="lbl">Fields Scanned</div>
      </div>
      <div class="card ${requiredFields > 0 ? 'blue' : ''}">
        <div class="num">${requiredFields}</div>
        <div class="lbl">Required Fields</div>
      </div>
    </div>

    <section>
      <h2>Form Structure</h2>
      ${totalForms === 0
        ? '<p class="muted">No &lt;form&gt; elements were found on this page.</p>'
        : formSections}
    </section>

    <section>
      <h2>Test Scenarios</h2>
      ${totalScenarios === 0
        ? '<p class="muted">No scenarios were run (no forms found).</p>'
        : scenarioSections}
    </section>

  </div>
</body>
</html>`;
}
