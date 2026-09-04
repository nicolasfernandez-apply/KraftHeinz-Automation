import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { Page } from '@playwright/test';

// ── Public types ──────────────────────────────────────────────────────────────

export interface GrammarIssue {
  /** Short one-line description of the problem */
  issue: string;
  /** The original text excerpt that contains the problem */
  originalText: string;
  /** Suggested corrected version (empty string when no clear fix exists) */
  suggestion: string;
  /** "error" for clear mistakes, "warning" for style/potential issues */
  severity: 'error' | 'warning';
  /** Broad category: grammar | spelling | punctuation | style | clarity */
  category: string;
}

export interface GrammarAnalysisResult {
  url: string;
  pageTitle: string;
  language: string;
  issues: GrammarIssue[];
  summary: string;
  /** ISO timestamp of when the analysis was performed */
  analyzedAt: string;
}

// ── Claude CLI helper ─────────────────────────────────────────────────────────

function findClaudeCli(): string {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 5_000 });
  if (!which.error && which.status === 0) return which.stdout.trim();

  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('claude CLI not found — install it with: npm install -g @anthropic-ai/claude-code');
}

// ── Page text extraction ──────────────────────────────────────────────────────

/**
 * Extracts visible human-readable text from the page.
 * Ignores scripts, styles, and hidden elements.
 */
async function extractPageText(page: Page): Promise<{ title: string; text: string; raw: string }> {
  return page.evaluate((): { title: string; text: string; raw: string } => {
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CODE', 'PRE']);

    function walk(node: Node, parts: string[]): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent ?? '').trim();
        if (t.length > 0) parts.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (skipTags.has(el.tagName)) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      for (const child of Array.from(el.childNodes)) walk(child, parts);
    }

    const parts: string[] = [];
    walk(document.body, parts);

    const raw = parts.join(' ').trim().slice(0, 40_000);
    const text = raw.replace(/\s+/g, ' ').trim();
    return { title: document.title, text, raw };
  });
}

// ── Double-space detection ────────────────────────────────────────────────────

function detectDoubleSpaces(text: string): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  const regex = / {2,}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const start = Math.max(0, match.index - 40);
    const end = Math.min(text.length, match.index + match[0].length + 40);
    const excerpt = text.slice(start, end).replace(/\n/g, '↵');
    issues.push({
      issue: 'Double (or extra) space detected',
      originalText: excerpt.slice(0, 120),
      suggestion: excerpt.replace(/ {2,}/g, ' ').slice(0, 120),
      severity: 'warning',
      category: 'punctuation',
    });
  }

  return issues;
}

// ── Claude invocation ─────────────────────────────────────────────────────────

/**
 * Sends the page text to Claude via the CLI and returns parsed grammar issues.
 */
export async function analyzeGrammar(
  page: Page,
  url: string,
  language: string,
): Promise<GrammarAnalysisResult> {
  const { title, text, raw } = await extractPageText(page);
  const doubleSpaceIssues = detectDoubleSpaces(raw);

  const prompt = `You are a professional copy editor analyzing the text contents of a web page written in ${language}.

Your task is to review the text for grammar, spelling, punctuation (including double spaces), style, and clarity issues.

Instructions:
- Focus only on the visible content text provided below.
- Report every clear error (wrong spelling, grammatical mistake, broken sentence, wrong punctuation).
- Also flag potential issues or style problems as warnings.
- Generate the report in English regardless of the page language.
- Return ONLY a valid JSON object — no markdown fences, no explanation outside JSON.

Return this exact JSON shape:
{
  "issues": [
    {
      "issue": "Short description of the problem",
      "originalText": "The exact text excerpt containing the problem (≤ 120 chars)",
      "suggestion": "Corrected version or empty string if unclear",
      "severity": "error" | "warning",
      "category": "grammar" | "spelling" | "punctuation" | "style" | "clarity"
    }
  ],
  "summary": "One-paragraph plain-English summary of the overall text quality."
}

Page URL: ${url}
Page language: ${language}

Page text:
${text}`;

  const claudePath = findClaudeCli();

  const proc = spawnSync(claudePath, ['--print'], {
    input: prompt,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });

  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(proc.stderr?.toString().trim() || `claude exited with code ${proc.status}`);
  }

  const claudeOutput = (proc.stdout as string) ?? '';
  const clean = claudeOutput.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(clean) as { issues: GrammarIssue[]; summary: string };

  return {
    url,
    pageTitle: title,
    language,
    issues: [...doubleSpaceIssues, ...(parsed.issues ?? [])],
    summary: parsed.summary ?? '',
    analyzedAt: new Date().toISOString(),
  };
}
