import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginToPreview, requireAuthConfig } from '../../utils/auth';
import {
  generateLinkFinderCsv,
  generateLinkFinderReport,
  LinkLocation,
  LinkMatch,
} from '../../utils/link-finder-report';

// ── Config ───────────────────────────────────────────────────────────────────

interface AuditUrlsConfig {
  /** Comma-separated string or array of target URLs to look for in page links. */
  targetUrl: string | string[];
  /** Array or comma-separated string of locales (xx-XX) whose pages are crawled. */
  locales?: string | string[];
  /** Alias of `locales`. */
  locale?: string | string[];
}

const configPath = process.env.AUDIT_URLS_CONFIG ?? path.resolve(process.cwd(), 'audits.urls.json');
if (!fs.existsSync(configPath)) {
  throw new Error(
    `\n  Audit URLs config not found: ${configPath}\n` +
    '  Create audits.urls.json in the repo root, or point AUDIT_URLS_CONFIG at a different file.\n',
  );
}

const config: AuditUrlsConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function toList(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : (value ?? '').split(',');
  return items.map((s) => s.trim()).filter(Boolean);
}

const targetUrls = toList(config.targetUrl);
const locales = toList(config.locales ?? config.locale);
if (targetUrls.length === 0) throw new Error('Config must include `targetUrl` (comma-separated string or string[]).');
if (locales.length === 0) throw new Error('Config must include `locales` (string[] or comma-separated string).');

// ── Crawl settings ───────────────────────────────────────────────────────────

interface SitemapSource {
  primary: string;
  fallback?: { url: string; replaceHost: [string, string] };
}

const SITEMAPS: SitemapSource[] = [
  { primary: 'https://www.heinz.com/sitemap.xml' },
  {
    primary: 'https://www.kraftheinz.com/sitemap.xml',
    fallback: {
      url: 'https://brands.prv.kraftheinz.com/sitemap.xml',
      replaceHost: ['brands.prv.kraftheinz.com', 'www.kraftheinz.com'],
    },
  },
];

const LOCALE_RE = /^\/([a-z]{2}-[A-Z]{2})(\/|$)/;

const PAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 10;

interface RawLink {
  href: string;
  text: string;
  location: LinkLocation;
}

function extractLocs(xml: string): string[] {
  return Array.from(new Set(
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()),
  ));
}

function extractLocale(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const match = LOCALE_RE.exec(pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Normalises a URL for comparison: drops protocol, `www.`, port, query string,
 * hash and trailing slash, and lowercases the result.
 * e.g. "HTTPS://www.Heinz.com/en-NZ/Products/?x=1#top" → "heinz.com/en-nz/products"
 * Returns null for non-http(s) hrefs (mailto:, tel:, javascript:, …).
 */
function normalizeUrl(raw: string): string | null {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./i, '');
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${host}${pathname}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A link matches a target when, after normalising both, it is the target itself
 * or a page beneath it. Matching on path-segment boundaries avoids false hits
 * such as heinz.com matching kraftheinz.com, or /products matching /products-old.
 */
function linkMatchesTarget(normalizedHref: string, normalizedTarget: string): boolean {
  return normalizedHref === normalizedTarget || normalizedHref.startsWith(`${normalizedTarget}/`);
}

test('Audit pages for links to the target URL(s)', async ({ browser }) => {
  test.setTimeout(0); // long-running crawl

  const normalizedTargets = targetUrls.map((t) => {
    const n = normalizeUrl(t);
    if (!n) throw new Error(`Invalid targetUrl in config: ${t}`);
    return { raw: t, normalized: n };
  });
  const localeSet = new Set(locales.map((l) => l.toLowerCase()));

  console.log(`[config] Target URL(s): ${targetUrls.join(', ')}`);
  console.log(`[config] Locale(s)    : ${locales.join(', ')}\n`);

  // ── 1. Fetch sitemaps ──────────────────────────────────────────────────────
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const seedPage = await ctx.newPage();

  const allUrls: string[] = [];

  for (const source of SITEMAPS) {
    console.log(`[sitemap] Fetching ${source.primary}…`);
    let locs: string[] = [];

    try {
      await seedPage.goto(source.primary, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const xml = await seedPage.content();
      locs = extractLocs(xml);
      console.log(`[sitemap] ${locs.length} URLs found in ${source.primary}`);
    } catch (err) {
      console.warn(`[sitemap] Failed to fetch ${source.primary}: ${(err as Error).message}`);
    }

    if (locs.length === 0 && source.fallback) {
      const { url: fallbackUrl, replaceHost: [from, to] } = source.fallback;
      console.log(`[sitemap] Primary returned 0 URLs — falling back to ${fallbackUrl}…`);

      try {
        const auth = requireAuthConfig();
        await loginToPreview(seedPage, auth, fallbackUrl);
        await seedPage.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const xml = await seedPage.content();
        const rawLocs = extractLocs(xml);
        locs = rawLocs.map((u) => u.replace(from, to));
        console.log(`[sitemap] ${locs.length} URLs found in fallback (hosts rewritten: ${from} → ${to})`);
      } catch (err) {
        console.error(`[sitemap] Fallback also failed: ${(err as Error).message}`);
      }
    }

    allUrls.push(...locs);
  }

  await seedPage.close();

  // ── 2. Filter to pages in the target locale(s) ─────────────────────────────
  const pageUrls = [...new Set(allUrls)].filter((u) => {
    const locale = extractLocale(u);
    return locale !== null && localeSet.has(locale.toLowerCase());
  });
  console.log(`\n[filter] ${pageUrls.length} URLs in locale(s) ${locales.join(', ')}.\n`);

  // ── 3. Fetch server HTML for each page and collect matching links ──────────
  const matches: LinkMatch[] = [];
  let processed = 0;
  const queue = [...pageUrls];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    // Blank page used only to parse HTML with DOMParser — scripts are not run
    // and no sub-resources are loaded, so this reflects the server HTML.
    const parserPage = await ctx.newPage();
    try {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        processed++;
        const locale = extractLocale(url)!;
        const prefix = `[${processed}/${pageUrls.length}]`;

        try {
          const res = await ctx.request.get(url, { timeout: PAGE_TIMEOUT_MS, failOnStatusCode: false });
          if (!res.ok()) {
            console.log(`${prefix} ✗ ${url} — HTTP ${res.status()}`);
            continue;
          }
          const html = await res.text();

          const links: RawLink[] = await parserPage.evaluate(({ html, baseUrl }) => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
            let base = baseUrl;
            try {
              if (baseHref) base = new URL(baseHref, baseUrl).href;
            } catch { /* keep page URL as base */ }

            const out: { href: string; text: string; location: string }[] = [];
            for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
              let href: string;
              try {
                href = new URL(a.getAttribute('href')!, base).href;
              } catch {
                continue;
              }
              const location =
                a.closest('header, [role="banner"]') ? 'header'
                : a.closest('footer, [role="contentinfo"]') ? 'footer'
                : a.closest('nav, [role="navigation"]') ? 'nav'
                : a.closest('main, [role="main"]') ? 'main'
                : 'other';
              // Join text nodes with spaces so card links don't run words together.
              const walker = doc.createTreeWalker(a, NodeFilter.SHOW_TEXT);
              const parts: string[] = [];
              while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
              const text = parts.join(' ').replace(/\s+/g, ' ').trim()
                || a.getAttribute('aria-label')
                || a.getAttribute('title')
                || '';
              out.push({ href, text, location });
            }
            return out;
          }, { html, baseUrl: res.url() }) as RawLink[];

          // Group identical links (same href, text, location, target) and count them.
          const grouped = new Map<string, LinkMatch>();
          for (const link of links) {
            const normalizedHref = normalizeUrl(link.href);
            if (!normalizedHref) continue;
            for (const target of normalizedTargets) {
              if (!linkMatchesTarget(normalizedHref, target.normalized)) continue;
              const key = [link.href, link.text, link.location, target.raw].join('\u0000');
              const existing = grouped.get(key);
              if (existing) {
                existing.occurrences++;
              } else {
                grouped.set(key, {
                  pageUrl: url,
                  locale,
                  targetUrl: target.raw,
                  href: link.href,
                  linkText: link.text,
                  location: link.location,
                  occurrences: 1,
                });
              }
            }
          }

          matches.push(...grouped.values());
          const count = [...grouped.values()].reduce((n, m) => n + m.occurrences, 0);
          const flag = count > 0 ? `✓ ${count} link(s)` : '–';
          console.log(`${prefix} [${locale}] ${flag} ${url}`);
        } catch (err) {
          const msg = (err as Error).message.split('\n')[0];
          console.log(`${prefix} ✗ ${url} — ${msg}`);
        }
      }
    } finally {
      await parserPage.close();
    }
  });

  await Promise.all(workers);

  // ── 4. Write CSV + HTML report ─────────────────────────────────────────────
  const outDir = path.join(process.cwd(), 'reports', 'audits');
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(outDir, `link-finder-audit-${timestamp}.csv`);
  const htmlPath = path.join(outDir, `link-finder-audit-${timestamp}.html`);

  matches.sort((a, b) => a.pageUrl.localeCompare(b.pageUrl) || a.location.localeCompare(b.location));

  fs.writeFileSync(csvPath, generateLinkFinderCsv(matches), 'utf8');
  fs.writeFileSync(htmlPath, generateLinkFinderReport({
    generatedAt: new Date().toISOString(),
    targetUrls,
    locales,
    pagesChecked: processed,
    matches,
  }), 'utf8');

  const pagesWithLinks = new Set(matches.map((m) => m.pageUrl)).size;

  console.log('\n' + '='.repeat(72));
  console.log('LINK FINDER AUDIT COMPLETE');
  console.log('='.repeat(72));
  console.log(`Pages checked        : ${processed}`);
  console.log(`Pages with links     : ${pagesWithLinks}`);
  console.log(`CSV saved to         : ${csvPath}`);
  console.log(`HTML report saved to : ${htmlPath}`);
  console.log('='.repeat(72) + '\n');

  await ctx.close();
});
