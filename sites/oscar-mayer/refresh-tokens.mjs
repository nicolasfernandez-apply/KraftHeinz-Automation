/**
 * Refreshes sites/oscar-mayer/design-tokens.json from the Figma API.
 *
 * Requires FIGMA_TOKEN env var.  FIGMA_FILE_KEY defaults to the Oscar Mayer DS
 * file key.  On any failure the existing file is left untouched and the process
 * exits with code 0 so the pipeline continues with the cached tokens.
 *
 * Usage:
 *   node sites/oscar-mayer/refresh-tokens.mjs
 *   FIGMA_TOKEN=figd_... node sites/oscar-mayer/refresh-tokens.mjs
 */

import https          from 'https';
import fs             from 'fs';
import path           from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIGMA_TOKEN    = process.env.FIGMA_TOKEN    ?? '';
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY ?? '4x9zraTVxAlxseCdCeEyYz';
const OUTPUT_FILE    = path.resolve(__dirname, 'design-tokens.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simple HTTPS GET → parsed JSON. Rejects on network or parse error. */
function figmaGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(
      {
        hostname: 'api.figma.com',
        path:     endpoint,
        headers:  { 'X-Figma-Token': FIGMA_TOKEN },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
      },
    ).on('error', reject);
  });
}

/**
 * Converts a flat { 'group/subgroup/name': value } map into a deeply nested
 * object, splitting keys on '/'.
 */
function nest(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('/');
    let node = out;
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) {
        node[parts[i]] = value;
      } else {
        node[parts[i]] ??= {};
        node = node[parts[i]];
      }
    }
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!FIGMA_TOKEN) {
    console.log('[refresh-tokens] FIGMA_TOKEN not set — skipping refresh, using existing file.');
    return;
  }

  console.log(`[refresh-tokens] Fetching styles from Figma file ${FIGMA_FILE_KEY}…`);

  // 1. Fetch style list
  let stylesResp;
  try {
    stylesResp = await figmaGet(`/v1/files/${FIGMA_FILE_KEY}/styles`);
    if (stylesResp.status !== 200) throw new Error(`API status ${stylesResp.status}`);
  } catch (err) {
    console.error(`[refresh-tokens] Could not fetch styles: ${err.message} — keeping existing tokens`);
    return;
  }

  const styles = stylesResp.meta?.styles ?? [];
  if (styles.length === 0) {
    console.warn('[refresh-tokens] No styles returned from Figma — keeping existing tokens');
    return;
  }

  // 2. Fetch the actual node data for all style nodes (values live there)
  const nodeIds = styles.map((s) => s.node_id).join(',');
  let nodesResp;
  try {
    nodesResp = await figmaGet(`/v1/files/${FIGMA_FILE_KEY}/nodes?ids=${nodeIds}`);
  } catch (err) {
    console.error(`[refresh-tokens] Could not fetch nodes: ${err.message} — keeping existing tokens`);
    return;
  }

  // 3. Parse styles into flat color / typography maps
  const styleMeta = {};
  styles.forEach((s) => { styleMeta[s.node_id] = s; });

  const colors     = {};
  const typography = {};

  for (const [nodeId, nodeData] of Object.entries(nodesResp.nodes ?? {})) {
    const doc  = nodeData.document;
    const meta = styleMeta[nodeId];
    if (!meta) continue;

    if (meta.style_type === 'FILL') {
      const fill = (doc.fills ?? []).find((f) => f.type === 'SOLID');
      if (fill) {
        const { r, g, b } = fill.color;
        const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
        colors[meta.name] = '#' + toHex(r) + toHex(g) + toHex(b);
      }
    } else if (meta.style_type === 'TEXT') {
      const s = doc.style ?? {};
      typography[meta.name] = {
        fontFamily:    s.fontFamily,
        fontStyle:     s.italic ? 'italic' : 'normal',
        fontWeight:    s.fontWeight,
        fontSize:      s.fontSize,
        lineHeightPx:  Math.round((s.lineHeightPx ?? 0) * 100) / 100,
        letterSpacing: s.letterSpacing ?? 0,
        textCase:      s.textCase ?? 'ORIGINAL',
      };
    }
  }

  // 4. Write output
  const output = {
    $schema:    'https://schemas.figma.com/design-tokens/0.0/schema.json',
    source:     `Figma file: Oscar Mayer — DS (${FIGMA_FILE_KEY})`,
    exportedAt: new Date().toISOString(),
    colors:     nest(colors),
    typography: nest(typography),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  const colorCount = Object.keys(colors).length;
  const typoCount  = Object.keys(typography).length;
  console.log(
    `[refresh-tokens] ✓ ${colorCount} color tokens, ${typoCount} typography tokens saved → ${OUTPUT_FILE}`,
  );
}

main().catch((err) => {
  // Never let an unexpected error break the pipeline — existing tokens remain in place.
  console.error(`[refresh-tokens] Unexpected error: ${err.message} — keeping existing tokens`);
  process.exit(0);
});
