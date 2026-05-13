import https from 'https';
import { DesignTokens } from './analyzer';

/**
 * Fetches design tokens from a Figma file via the public REST API and returns
 * them in the same nested shape that analyzePage() expects. Mirrors the logic
 * in sites/oscar-mayer/refresh-tokens.mjs but keeps the result in memory
 * rather than writing to disk — suitable for ad-hoc single-page analyses.
 *
 * @throws Error if the API call fails or returns no usable styles. Callers
 *         that want a graceful skip should wrap this in a try/catch and fall
 *         back to passing `null` to analyzePage().
 */
export async function fetchFigmaTokens(
  fileKey: string,
  token: string,
): Promise<DesignTokens> {
  if (!fileKey) throw new Error('fetchFigmaTokens: fileKey is required');
  if (!token)   throw new Error('fetchFigmaTokens: FIGMA_TOKEN env var is required');

  // 1. List the styles defined in the file.
  const stylesResp = await figmaGet(`/v1/files/${fileKey}/styles`, token);
  if (stylesResp.status !== 200) {
    throw new Error(`Figma /styles returned status ${stylesResp.status}`);
  }
  const styles: FigmaStyleMeta[] = stylesResp.meta?.styles ?? [];
  if (styles.length === 0) {
    throw new Error('Figma file contains no styles');
  }

  // 2. Fetch the actual node data — that's where the colour / type values live.
  const nodeIds  = styles.map((s) => s.node_id).join(',');
  const nodesResp = await figmaGet(`/v1/files/${fileKey}/nodes?ids=${nodeIds}`, token);

  // 3. Flatten into slash-separated maps, then nest them by '/'.
  const styleMeta: Record<string, FigmaStyleMeta> = {};
  styles.forEach((s) => { styleMeta[s.node_id] = s; });

  const colors:     Record<string, string>            = {};
  const typography: Record<string, Record<string, unknown>> = {};

  for (const [nodeId, nodeData] of Object.entries(nodesResp.nodes ?? {}) as [string, FigmaNodeData][]) {
    const doc  = nodeData.document;
    const meta = styleMeta[nodeId];
    if (!meta) continue;

    if (meta.style_type === 'FILL') {
      const fill = (doc.fills ?? []).find((f) => f.type === 'SOLID');
      if (fill?.color) {
        const { r, g, b } = fill.color;
        const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
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

  return {
    colors:     nest(colors),
    typography: nest(typography),
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

interface FigmaStyleMeta {
  node_id:    string;
  name:       string;
  style_type: 'FILL' | 'TEXT' | string;
}

interface FigmaFill {
  type:  string;
  color?: { r: number; g: number; b: number };
}

interface FigmaTextStyle {
  fontFamily?:    string;
  fontWeight?:    number;
  fontSize?:      number;
  italic?:        boolean;
  lineHeightPx?:  number;
  letterSpacing?: number;
  textCase?:      string;
}

interface FigmaNodeData {
  document: { fills?: FigmaFill[]; style?: FigmaTextStyle };
}

function figmaGet(endpoint: string, token: string): Promise<{ status?: number; meta?: { styles: FigmaStyleMeta[] }; nodes?: Record<string, FigmaNodeData> }> {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: 'api.figma.com',
          path:     endpoint,
          headers:  { 'X-Figma-Token': token },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error(`JSON parse failed: ${(e as Error).message}`)); }
          });
        },
      )
      .on('error', reject);
  });
}

/** Splits flat "a/b/c" keys into a deeply nested object. */
function nest<V>(flat: Record<string, V>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('/');
    let node: Record<string, unknown> = out;
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) {
        node[parts[i]] = value;
      } else {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') {
          node[parts[i]] = {};
        }
        node = node[parts[i]] as Record<string, unknown>;
      }
    }
  }
  return out;
}
