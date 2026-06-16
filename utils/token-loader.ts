import * as fs from 'fs';
import * as path from 'path';
import { DesignTokens, NamedTokenSet } from './analyzer';

/**
 * Reads every `*.tokens.json` file in `tokensDir`, parses the Figma DTCG
 * format ({ "$type": "color", "$value": { hex } } leaves), and returns one
 * NamedTokenSet per file. Files containing no recognisable color tokens are
 * skipped.
 *
 * The DTCG files produced by Figma's variable export carry only colors today
 * (no typography). The returned `tokens.typography` is therefore an empty
 * object — analyzePage() treats an empty typography set as "fonts are not
 * tokenised here" rather than flagging every font on the page.
 *
 * Name is derived from the filename with the `.tokens.json` suffix stripped,
 * so `Heinz - Ketchup Red.tokens.json` becomes `Heinz - Ketchup Red`.
 *
 * Returns an empty array if the directory doesn't exist or contains no
 * matching files — callers can decide whether to skip the compliance check.
 */
export function loadTokenSets(tokensDir: string): NamedTokenSet[] {
  if (!fs.existsSync(tokensDir)) return [];

  const files = fs.readdirSync(tokensDir)
    .filter((f) => f.toLowerCase().endsWith('.tokens.json'))
    .sort();

  const sets: NamedTokenSet[] = [];
  for (const file of files) {
    const set = loadTokenFile(path.join(tokensDir, file));
    if (set) sets.push(set);
  }
  return sets;
}

/**
 * Loads a single `*.tokens.json` file (Figma DTCG format) and returns it as a
 * NamedTokenSet. Used by the single-page analyse flow, which compares one URL
 * against one chosen palette rather than picking a best match.
 *
 * Returns null if the file is missing, unreadable, or contains no usable
 * color tokens — callers can decide how to react (warn-and-skip vs. throw).
 */
export function loadTokenFile(filePath: string): NamedTokenSet | null {
  if (!fs.existsSync(filePath)) {
    console.warn(`[token-loader] Token file not found: ${filePath}`);
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[token-loader] Skipping ${filePath}: ${(e as Error).message}`);
    return null;
  }

  const colors = extractDtcgColors(raw);
  if (!colors || Object.keys(colors).length === 0) {
    console.warn(`[token-loader] ${filePath} contained no color tokens — skipping.`);
    return null;
  }

  const base = path.basename(filePath).replace(/\.tokens\.json$/i, '');
  return {
    name: base,
    tokens: { colors, typography: {} },
  };
}

/**
 * Walks a DTCG-style token tree and produces a nested `{ groupName: { ...: '#hex' } }`
 * structure compatible with the analyzer's `flattenTokenColors` helper, which
 * collects every leaf string that starts with `#`.
 *
 * DTCG leaves look like `{ $type: 'color', $value: { hex, components, alpha } }`.
 * We replace each such leaf with its hex string; non-color leaves (`$type`
 * 'string', 'number', etc.) are dropped, as are nodes with no usable hex.
 */
function extractDtcgColors(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;

  // DTCG token leaf — has $type and $value.
  if (typeof rec.$type === 'string') {
    if (rec.$type !== 'color') return null;
    const value = rec.$value as { hex?: string; components?: number[]; alpha?: number } | undefined;
    if (!value) return null;

    let hex = typeof value.hex === 'string' ? value.hex.toLowerCase() : '';
    if (!hex && Array.isArray(value.components) && value.components.length >= 3) {
      const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
      hex = '#' + value.components.slice(0, 3).map(toHex).join('');
    }
    if (!hex || !hex.startsWith('#')) return null;

    // Represent a single color token by returning the hex string directly;
    // the caller will splice it into its parent's group.
    return { __leaf__: hex };
  }

  // Group node — recurse into children.
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    if (key.startsWith('$')) continue; // DTCG metadata
    const parsed = extractDtcgColors(child);
    if (parsed === null) continue;
    if ('__leaf__' in parsed && Object.keys(parsed).length === 1) {
      out[key] = parsed.__leaf__;
    } else if (Object.keys(parsed).length > 0) {
      out[key] = parsed;
    }
  }
  return out;
}
