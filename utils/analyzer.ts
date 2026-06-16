import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'fs';

export interface PageMetadata {
  title: string;
  description: string;
  canonical: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  keywords: string;
  robots: string;
  charset: string;
  viewport: string;
  language: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface ImageInfo {
  src: string;
  alt: string;
  hasAlt: boolean;
}

export interface LinkInfo {
  href: string;
  text: string;
  isExternal: boolean;
}

export interface FormInfo {
  action: string;
  method: string;
  inputs: string[];
}

export interface VideoInfo {
  /** 'native' | 'youtube' | 'vimeo' | 'wistia' | 'iframe' */
  platform: string;
  /** Absolute src URL as resolved by the browser */
  src: string;
  /** Extracted video ID for YouTube / Vimeo / Wistia; full src for others */
  videoId: string;
  /** title attribute if present */
  title: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

// ── Design token types ────────────────────────────────────────────────────────

/** Nested color/typography token structure consumed by analyzePage(). */
export interface DesignTokens {
  colors:     Record<string, unknown>;
  typography: Record<string, unknown>;
}

/**
 * A named design-token set. When an array of these is passed to analyzePage(),
 * the analyzer runs the compliance check against each set independently and
 * returns the violations from the set with the fewest total mismatches (along
 * with that set's name in `PageAnalysis.matchedTokenSet`).
 */
export interface NamedTokenSet {
  name:   string;
  tokens: DesignTokens;
}

/** A color found on the page that is not present in the design token palette. */
export interface ColorViolation {
  color:      string;   // lowercase hex, e.g. "#ff0000"
  count:      number;   // number of elements using this color
  properties: string[]; // CSS properties where it was found
  samples:    string[]; // up to 3 example element descriptors (tag#id.class) that use this color
}

/** A font family + weight combination found on the page that is not in the design token set. */
export interface FontViolation {
  fontFamily: string;
  fontWeight: number;   // numeric CSS weight (100–900); keywords normalised to numbers
  count:      number;
  samples:    string[]; // up to 3 example element descriptors that use this font
}

export interface DesignTokenViolations {
  /** Non-token colors found on the page, sorted by element count descending. */
  unknownColors: ColorViolation[];
  /** Non-token font families found on the page. */
  unknownFonts: FontViolation[];
  /** Number of distinct token-compliant colors actually used. */
  compliantColorCount: number;
  /** Number of distinct token-compliant font families actually used. */
  compliantFontCount: number;
}

export interface AxeViolationNode {
  /** CSS selector path to the element */
  target: string;
  /** HTML snippet of the affected element */
  html: string;
  /** Why this element fails the rule */
  failureSummary: string;
}

export interface AxeViolation {
  id: string;
  /** "critical" | "serious" | "moderate" | "minor" */
  impact: string;
  help: string;
  helpUrl: string;
  nodes: AxeViolationNode[];
}

export interface PerformanceMetrics {
  loadTime: number;
  domContentLoaded: number;
  firstContentfulPaint: number;
  responseEnd: number;
  domInteractive: number;
  transferSize: number;
  decodedBodySize: number;
}

export interface PageAnalysis {
  url: string;
  finalUrl: string;
  statusCode: number;
  loadError: string | null;
  metadata: PageMetadata;
  headings: HeadingInfo[];
  images: ImageInfo[];
  links: LinkInfo[];
  forms: FormInfo[];
  videos: VideoInfo[];
  consoleEntries: ConsoleEntry[];
  performance: PerformanceMetrics;
  screenshotBase64: string;
  scriptsCount: number;
  stylesheetsCount: number;
  /** Visible text blocks extracted from content elements (p, li, td, blockquote…) */
  textBlocks: string[];
  /** Accessibility violations found by axe-core */
  axeViolations: AxeViolation[];
  /**
   * Design-token compliance check results.
   * null when no design tokens were provided to analyzePage().
   * When multiple token sets are passed, this holds the result for the
   * best-matching set (the one with the fewest total violations).
   */
  designTokenViolations: DesignTokenViolations | null;
  /**
   * Name of the token set whose comparison produced `designTokenViolations`.
   * null when no tokens were provided, when a single (un-named) set was
   * passed, or when token analysis failed.
   */
  matchedTokenSet: string | null;
  /**
   * All token set names that achieved a perfect score (0 element violations).
   * Contains only `matchedTokenSet` when only one theme hits zero, or is empty
   * when the best score is non-zero.
   */
  matchedTokenSets: string[];
  timestamp: string;
}

const EMPTY_METADATA: PageMetadata = {
  title: '', description: '', canonical: '', ogTitle: '',
  ogDescription: '', ogImage: '', keywords: '', robots: '',
  charset: '', viewport: '', language: '',
};

const EMPTY_PERFORMANCE: PerformanceMetrics = {
  loadTime: 0, domContentLoaded: 0, firstContentfulPaint: 0,
  responseEnd: 0, domInteractive: 0, transferSize: 0, decodedBodySize: 0,
};

// ── Design-token helpers ──────────────────────────────────────────────────────

/** Recursively collect every leaf hex string from a nested color token object. */
function flattenTokenColors(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof obj === 'string' && obj.startsWith('#')) {
    out.add(obj.toLowerCase());
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) flattenTokenColors(v, out);
  }
  return out;
}

/**
 * Normalises a font-family string so comparisons are case-insensitive and
 * robust to surrounding quotes/whitespace. Used by BOTH the token side and
 * the page side so the two are guaranteed to produce the same key for the
 * same logical font.
 */
function normalizeFontFamily(raw: string): string {
  return raw
    .split(',')[0]        // take first family if it's a CSS stack
    .trim()
    .replace(/['"]/g, '') // strip quote characters
    .toLowerCase();
}

/**
 * Pattern (as a string so it can be re-built inside page.evaluate) that
 * matches fonts whose weight is baked into the family name — e.g.
 * "FilsonProBlack", "OpenSansBold", "InterSemiBoldItalic". For these fonts
 * the CSS `font-weight` value is unreliable: the visual weight is
 * determined by which font face the browser loaded, and UA stylesheets
 * (`h1`–`h6`, `<strong>`, `<th>`, `<dt>` etc.) force `font-weight: bold` on
 * top, producing apparent weight mismatches that don't reflect a real
 * design-system violation.
 *
 * When a family matches this pattern, we drop the weight from the lookup
 * key and compare by family alone.
 */
const WEIGHT_SUFFIX_PATTERN =
  '(thin|extralight|ultralight|light|regular|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|book)(italic)?$';

/**
 * Builds the canonical lookup key for a (family, weight) pair. Used by both
 * the token side and the page side so they produce identical keys for the
 * same logical font.
 */
function fontLookupKey(family: string, weight: number): string {
  return new RegExp(WEIGHT_SUFFIX_PATTERN).test(family)
    ? `${family}|*`
    : `${family}|${weight}`;
}

/**
 * Maps weight-suffix words (lowercase) to their canonical CSS weight number.
 * Used by the page-side alias resolver to translate things like
 * "FilsonProBold" → ("Filson Pro", 700).
 */
const WEIGHT_WORD_TO_NUMBER: Record<string, number> = {
  thin:       100,
  extralight: 200, ultralight: 200,
  light:      300,
  book:       425, regular: 400, normal: 400,
  medium:     500,
  semibold:   600, demibold: 600,
  bold:       700,
  extrabold:  800, ultrabold: 800,
  black:      900, heavy: 900,
};

/**
 * Builds a "compressed → canonical" alias map from the token typography tree.
 * For every token family that contains non-alphanumeric characters (spaces,
 * hyphens, underscores), we register `compressed → canonical` so the page side
 * can resolve a CSS font name like "FilsonProBold" back to the design-system's
 * canonical family "Filson Pro" by stripping the weight suffix and looking up
 * the remaining base in this map.
 */
function buildFontAliasMap(
  obj: unknown,
  out: Record<string, string> = {},
): Record<string, string> {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.fontFamily === 'string') {
      const canonical  = normalizeFontFamily(rec.fontFamily);
      const compressed = canonical.replace(/[^a-z0-9]/g, '');
      if (compressed !== canonical && !(compressed in out)) {
        out[compressed] = canonical;
      }
    }
    for (const v of Object.values(rec)) buildFontAliasMap(v, out);
  }
  return out;
}

/**
 * Collect every distinct (fontFamily, fontWeight) tuple from a nested typography
 * token object. Each entry is encoded as `"family|weight"` (normalised family,
 * numeric weight) so it can be looked up with a single Set.has() call.
 */
function flattenTokenFonts(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.fontFamily === 'string') {
      const family = normalizeFontFamily(rec.fontFamily);
      const weight = Number(rec.fontWeight) || 400;
      out.add(fontLookupKey(family, weight));
    }
    for (const v of Object.values(rec)) flattenTokenFonts(v, out);
  }
  return out;
}

// ── Node-side token comparison ────────────────────────────────────────────────
// `analyzePage` extracts raw color/font maps inside `page.evaluate` once, then
// calls this helper against each candidate token set. Keeping the comparison
// off the page makes multi-set scoring cheap (no extra page evaluations).

interface RawColorEntry { count: number; properties: string[]; samples: string[]; }
interface RawFontEntry  { fontFamily: string; fontWeight: number; count: number; samples: string[]; }

function computeTokenViolations(
  colorMap: Record<string, RawColorEntry>,
  fontMap:  Record<string, RawFontEntry>,
  tokens:   DesignTokens,
): DesignTokenViolations {
  const tokenColorSet = flattenTokenColors(tokens.colors);
  const tokenFontSet  = flattenTokenFonts(tokens.typography);
  const fontAliases   = buildFontAliasMap(tokens.typography);
  const weightSuffixRe = new RegExp(WEIGHT_SUFFIX_PATTERN);

  // When the token set defines no typography (e.g. DTCG color-only tokens),
  // every font on the page would otherwise be flagged. Treat font compliance
  // as a no-op in that case.
  const fontsAreTokenised = tokenFontSet.size > 0;

  const aliasedKeyFor = (family: string): string | null => {
    const m = family.match(weightSuffixRe);
    if (!m) return null;
    const base = family.slice(0, family.length - m[0].length);
    const canonical = fontAliases[base];
    if (!canonical) return null;
    const weight = WEIGHT_WORD_TO_NUMBER[m[1].toLowerCase()] ?? 400;
    return `${canonical}|${weight}`;
  };

  const isFontCompliant = (key: string, family: string): boolean => {
    if (!fontsAreTokenised) return true;
    if (tokenFontSet.has(key)) return true;
    const aliased = aliasedKeyFor(family);
    return aliased !== null && tokenFontSet.has(aliased);
  };

  const unknownColors = Object.entries(colorMap)
    .filter(([hex]) => !tokenColorSet.has(hex))
    .map(([color, data]) => ({
      color,
      count:      data.count,
      properties: data.properties,
      samples:    data.samples,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  const compliantColorCount = Object.keys(colorMap)
    .filter((hex) => tokenColorSet.has(hex)).length;

  const unknownFonts = Object.entries(fontMap)
    .filter(([key, data]) => !isFontCompliant(key, data.fontFamily))
    .map(([, data]) => ({
      fontFamily: data.fontFamily,
      fontWeight: data.fontWeight,
      count:      data.count,
      samples:    data.samples,
    }))
    .sort((a, b) => b.count - a.count);

  const compliantFontCount = Object.entries(fontMap)
    .filter(([key, data]) => isFontCompliant(key, data.fontFamily)).length;

  return { unknownColors, compliantColorCount, unknownFonts, compliantFontCount };
}

export async function analyzePage(
  page: Page,
  url: string,
  screenshotPath: string,
  designTokens?: DesignTokens | NamedTokenSet[] | null,
): Promise<PageAnalysis> {
  const consoleEntries: ConsoleEntry[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    // Skip error-logging endpoint calls — they are environment-specific noise
    // (e.g. client-side error reporters that fire only on one side).
    if (text.includes('/log/error?msg=')) return;
    consoleEntries.push({ type: msg.type(), text });
  });

  let statusCode = 0;
  let loadError: string | null = null;
  let finalUrl = url;

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    statusCode = response?.status() ?? 0;

    // Wait for network to settle (up to 10s, non-blocking)
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    finalUrl = page.url();
  } catch (error) {
    loadError = (error as Error).message;
  }

  const metadata = await page
    .evaluate(() => {
      const getMeta = (selector: string): string => {
        const el = document.querySelector(selector);
        if (!el) return '';
        return (el as HTMLMetaElement).content || el.getAttribute('href') || '';
      };
      return {
        title: document.title,
        description: getMeta('meta[name="description"]'),
        canonical: getMeta('link[rel="canonical"]'),
        ogTitle: getMeta('meta[property="og:title"]'),
        ogDescription: getMeta('meta[property="og:description"]'),
        ogImage: getMeta('meta[property="og:image"]'),
        keywords: getMeta('meta[name="keywords"]'),
        robots: getMeta('meta[name="robots"]'),
        charset: document.characterSet,
        viewport: getMeta('meta[name="viewport"]'),
        language: document.documentElement.lang || '',
      };
    })
    .catch(() => EMPTY_METADATA);

  // Carousel selector — applied across content extractors so rotating items
  // don't show up as preview/production differences.
  const CAROUSEL_SELECTOR = '[aria-label="Carousel" i], [aria-roledescription="carousel" i]';

  const headings = await page
    .evaluate((carouselSel: string) =>
      Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter((el) => !el.closest(carouselSel))
        .map((el) => ({
          level: parseInt(el.tagName[1], 10),
          text: (el as HTMLElement).innerText.trim().substring(0, 200),
        }))
        .filter((h) => h.text),
      CAROUSEL_SELECTOR,
    )
    .catch(() => [] as HeadingInfo[]);

  const images = await page
    .evaluate((carouselSel: string) =>
      Array.from(document.querySelectorAll('img'))
        // Exclude carousel descendants — slide content rotates between runs.
        .filter((el) => !el.closest(carouselSel))
        .map((img) => ({
          src: img.getAttribute('src') || '',
          alt: img.alt || '',
          hasAlt: img.hasAttribute('alt') && img.alt.trim() !== '',
        }))
        // Exclude cookie-consent service logos — they are injected by consent
        // SDKs and differ between environments based on banner visibility.
        // Exclude tracking/logging pixels — environment-specific noise.
        // Check the pathname so that both relative (/log/...) and absolute
        // (https://domain/log/...) tracking URLs are caught.
        .filter((img) => {
          if (img.src.includes('/logos/')) return false;
          let pathname = img.src;
          try { pathname = new URL(img.src).pathname; } catch {}
          return !pathname.startsWith('/log/');
        }),
      CAROUSEL_SELECTOR,
    )
    .catch(() => [] as ImageInfo[]);

  const links = await page
    .evaluate(({ pageUrl, carouselSel }: { pageUrl: string; carouselSel: string }) => {
      // Walk up the DOM; return true if the element lives inside a cookie consent container.
      const isCookieBanner = (el: Element): boolean => {
        let node: Element | null = el.parentElement;
        while (node) {
          const cls = (node.getAttribute('class') || '').toLowerCase();
          const id  = (node.getAttribute('id')    || '').toLowerCase();
          if (
            cls.includes('cookie')    || id.includes('cookie')    ||
            cls.includes('consent')   || id.includes('consent')   ||
            cls.includes('gdpr')      || id.includes('gdpr')      ||
            cls.includes('onetrust')  || id.includes('onetrust')  ||
            cls.includes('cookiebot') || id.includes('cookiebot') ||
            cls.includes('cky-')      || id.includes('cky-')      ||
            cls.includes('osano')     || id.includes('osano')
          ) return true;
          node = node.parentElement;
        }
        return false;
      };

      let pageOrigin = '';
      try {
        pageOrigin = new URL(pageUrl).origin;
      } catch {}
      return Array.from(document.querySelectorAll('a[href]'))
        // Exclude carousel descendants — slide content rotates between runs.
        .filter((a) => !a.closest(carouselSel))
        .filter((a) => !isCookieBanner(a))
        .slice(0, 300)
        .map((a) => {
          const el = a as HTMLAnchorElement;
          let isExternal = false;
          try {
            isExternal = new URL(el.href).origin !== pageOrigin;
          } catch {}
          return {
            href: el.getAttribute('href') || '',
            text: el.innerText.trim().substring(0, 100),
            isExternal,
          };
        })
        .filter((l) => {
          if (!l.href || l.href === '#' || l.href.startsWith('javascript:')) return false;
          if (l.href.includes('/logos/')) return false;
          // Exclude "where to buy" widget links — environment-specific retailer lookups.
          // Check pathname so that both relative (/wtb/...) and absolute
          // (https://domain/wtb/...) forms are caught.
          let pathname = l.href;
          try { pathname = new URL(l.href).pathname; } catch {}
          return !pathname.startsWith('/wtb/');
        });
    }, { pageUrl: url, carouselSel: CAROUSEL_SELECTOR })
    .catch(() => [] as LinkInfo[]);

  const forms = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('form')).map((form) => ({
        action: (form as HTMLFormElement).action || '',
        method: (form as HTMLFormElement).method || 'get',
        inputs: Array.from(form.querySelectorAll('input, select, textarea')).map((el) => {
          const input = el as HTMLInputElement;
          return `${el.tagName.toLowerCase()}[${input.type || el.tagName.toLowerCase()}]${input.name ? ` name="${input.name}"` : ''}`;
        }),
      })),
    )
    .catch(() => [] as FormInfo[]);

  // Only native <video> elements are collected — iframes are excluded to avoid false
  // positives from Recaptcha, cookie banners, analytics, and other embedded widgets.
  const videos = await page
    .evaluate((carouselSel: string) => {
      const items: Array<{ platform: string; src: string; videoId: string; title: string }> = [];

      document.querySelectorAll('video').forEach((el) => {
        const v = el as HTMLVideoElement;
        // Exclude carousel descendants — slide content rotates between runs.
        if (v.closest(carouselSel)) return;
        // Prefer the resolved .src property; fall back to the first <source> child
        const src = v.src || (v.querySelector('source') as HTMLSourceElement | null)?.src || '';
        if (!src) return;
        items.push({ platform: 'native', src, videoId: src, title: v.getAttribute('title') || '' });
      });

      return items;
    }, CAROUSEL_SELECTOR)
    .catch(() => [] as Array<{ platform: string; src: string; videoId: string; title: string }>);

  const performance = await page
    .evaluate(() => {
      const entries = window.performance.getEntriesByType('navigation');
      if (entries.length === 0) return null;
      const nav = entries[0] as PerformanceNavigationTiming;
      const fcpEntry = window.performance.getEntriesByName('first-contentful-paint')[0];
      return {
        loadTime: Math.round(nav.loadEventEnd - nav.startTime),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
        firstContentfulPaint: fcpEntry ? Math.round(fcpEntry.startTime) : 0,
        responseEnd: Math.round(nav.responseEnd - nav.startTime),
        domInteractive: Math.round(nav.domInteractive - nav.startTime),
        transferSize: nav.transferSize || 0,
        decodedBodySize: nav.decodedBodySize || 0,
      };
    })
    .catch(() => null);

  // Extract visible text blocks from content elements.
  // Targets leaf-level elements that carry readable text; deduplicates and filters noise.
  // Elements inside cookie consent containers are excluded to avoid environment differences
  // caused by banners that appear differently between Preview and Production.
  const textBlocks = await page
    .evaluate((carouselSel: string) => {
      const isCookieBanner = (el: Element): boolean => {
        let node: Element | null = el.parentElement;
        while (node) {
          const cls = (node.getAttribute('class') || '').toLowerCase();
          const id  = (node.getAttribute('id')    || '').toLowerCase();
          if (
            cls.includes('cookie')    || id.includes('cookie')    ||
            cls.includes('consent')   || id.includes('consent')   ||
            cls.includes('gdpr')      || id.includes('gdpr')      ||
            cls.includes('onetrust')  || id.includes('onetrust')  ||
            cls.includes('cookiebot') || id.includes('cookiebot') ||
            cls.includes('cky-')      || id.includes('cky-')      ||
            cls.includes('osano')     || id.includes('osano')
          ) return true;
          node = node.parentElement;
        }
        return false;
      };

      const seen = new Set<string>();
      const blocks: string[] = [];
      const elements = Array.from(document.querySelectorAll(
        'p, li, td, th, blockquote, figcaption, label, caption, dt, dd',
      ));
      for (const el of elements) {
        if (isCookieBanner(el)) continue;
        // Exclude carousel descendants — slide content rotates between runs.
        if (el.closest(carouselSel)) continue;
        // Skip elements that themselves contain block children (avoids duplicating parent text)
        if (el.querySelector('p, li, blockquote, div')) continue;
        // Only consider elements that expose an innerText string. Pure Element
        // / SVGElement instances don't, and the property is also undefined on
        // disconnected or shadow-DOM nodes — we want concrete rendered text.
        const innerText = (el as HTMLElement).innerText;
        if (typeof innerText !== 'string') continue;
        const text = innerText.replace(/\s+/g, ' ').trim().substring(0, 400);
        if (text && text.length >= 15 && !seen.has(text)) {
          seen.add(text);
          blocks.push(text);
        }
      }
      return blocks.slice(0, 500);
    }, CAROUSEL_SELECTOR)
    .catch(() => [] as string[]);

  const { scriptsCount, stylesheetsCount } = await page
    .evaluate(() => ({
      scriptsCount: document.querySelectorAll('script[src]').length,
      stylesheetsCount: document.querySelectorAll('link[rel="stylesheet"]').length,
    }))
    .catch(() => ({ scriptsCount: 0, stylesheetsCount: 0 }));

  let screenshotBase64 = '';
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');
  } catch (e) {
    console.warn('Screenshot failed:', (e as Error).message);
  }

  let axeViolations: AxeViolation[] = [];
  try {
    // Restrict to <body> so head/scripts/document-level rules don't fire — those
    // concerns are covered by the metadata diff. Exclude common cookie/consent
    // SDK containers (OneTrust, Cookiebot, Cookieyes, Osano, generic cookie/gdpr)
    // because their markup is environment-specific noise.
    const axeResults = await new AxeBuilder({ page })
      .include('body')
      .exclude('[id*="onetrust" i]')
      .exclude('[class*="onetrust" i]')
      .exclude('[id*="cookie" i]')
      .exclude('[class*="cookie" i]')
      .exclude('[id*="consent" i]')
      .exclude('[class*="consent" i]')
      .exclude('[id*="cookiebot" i]')
      .exclude('[class*="cookiebot" i]')
      .exclude('[id*="cky-" i]')
      .exclude('[class*="cky-" i]')
      .exclude('[id*="osano" i]')
      .exclude('[class*="osano" i]')
      .exclude('[id*="gdpr" i]')
      .exclude('[class*="gdpr" i]')
      .analyze();
    axeViolations = axeResults.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target.join(' > '),
        html: n.html,
        failureSummary: n.failureSummary ?? '',
      })),
    }));
  } catch (e) {
    console.warn('axe-core analysis failed:', (e as Error).message);
  }

  // ── Design-token compliance check ─────────────────────────────────────────
  // Only runs when design tokens are provided (Oscar Mayer comparison).
  // Samples up to 800 visible elements on the page, extracts computed
  // background-color / color / border-color and font-family values, then
  // compares them against the flat set of values defined in the token file.

  let designTokenViolations: DesignTokenViolations | null = null;
  let matchedTokenSet: string | null = null;
  let matchedTokenSets: string[] = [];

  // Normalise the tokens argument into a list of candidate sets so the
  // analysis branch is the same whether the caller passed null, a single
  // (un-named) DesignTokens object, or a list of named sets.
  const tokenCandidates: NamedTokenSet[] = !designTokens
    ? []
    : Array.isArray(designTokens)
      ? designTokens
      : [{ name: '', tokens: designTokens }];

  if (tokenCandidates.length > 0) {
    // ── Page-side raw style sampling ──────────────────────────────────────
    // Extract raw colorMap and fontMap once; comparison against each token
    // set happens Node-side below so a multi-set selection doesn't re-load
    // the page.
    const rawStyles = await page
      .evaluate(
        ({ weightSuffixPattern }) => {
          const weightSuffixRe = new RegExp(weightSuffixPattern);
          const buildFontKey = (fam: string, wt: number): string =>
            weightSuffixRe.test(fam) ? `${fam}|*` : `${fam}|${wt}`;
          // ── Cookie/consent ancestor detector ─────────────────────────────
          // Mirrors the same filter applied to text/links extraction so that
          // OneTrust, Cookiebot, etc. don't pollute the token compliance check.
          const isCookieBanner = (el: Element): boolean => {
            let node: Element | null = el.parentElement;
            while (node) {
              const cls = (node.getAttribute('class') || '').toLowerCase();
              const id  = (node.getAttribute('id')    || '').toLowerCase();
              if (
                cls.includes('cookie')    || id.includes('cookie')    ||
                cls.includes('consent')   || id.includes('consent')   ||
                cls.includes('gdpr')      || id.includes('gdpr')      ||
                cls.includes('onetrust')  || id.includes('onetrust')  ||
                cls.includes('cookiebot') || id.includes('cookiebot') ||
                cls.includes('cky-')      || id.includes('cky-')      ||
                cls.includes('osano')     || id.includes('osano')
              ) return true;
              node = node.parentElement;
            }
            return false;
          };

          /** Short selector-like description: tag#id, tag.class, or tag. */
          const describeElement = (el: HTMLElement): string => {
            let s = el.tagName.toLowerCase();
            if (el.id) {
              s += '#' + el.id;
            } else if (typeof el.className === 'string' && el.className.trim()) {
              const classes = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
              if (classes.length) s += '.' + classes.join('.');
            }
            return s;
          };

          // ── Color extraction ─────────────────────────────────────────────
          // Only `background-color` is compared. Text color is excluded
          // because text-bearing elements (h1–h6, p, a, span, etc.) are in
          // FONT_ONLY_TAGS, and border colors produced too much per-side noise
          // to be useful.
          const COLOR_PROPS = ['backgroundColor'] as const;

          /** Convert rgb(r,g,b) / rgba(r,g,b,a) → lowercase hex, or null. */
          const rgbToHex = (val: string): string | null => {
            const m = val.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (!m) return null;
            const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
            if (alpha < 0.05) return null; // fully transparent — skip
            return '#' + [m[1], m[2], m[3]]
              .map((n) => parseInt(n, 10).toString(16).padStart(2, '0'))
              .join('');
          };

          const colorMap: Record<string, { count: number; properties: string[]; samples: string[] }> = {};
          const fontMap:  Record<string, { fontFamily: string; fontWeight: number; count: number; samples: string[] }> = {};

          /**
           * Strict "actually shown to the user" check. The default
           * offsetWidth/Height test misses several common hide patterns:
           *   - visibility: hidden / collapse  (preserves layout space)
           *   - opacity: 0                     (preserves layout space)
           *   - sr-only positioning            (1x1 clipped, or left: -9999px)
           *   - content-visibility: hidden     (skipped rendering)
           *   - off-screen via transforms      (display flex on desktop nav
           *                                     can be translated off-screen
           *                                     on mobile and vice-versa)
           */
          const isUserVisible = (el: HTMLElement): boolean => {
            // 1. Display/zero-size check (also catches display:none ancestors).
            if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;

            // 2. Modern combined check — handles visibility, opacity,
            //    content-visibility:auto, and ancestor chains in one call.
            //    Chromium-based (Playwright's bundled browser) supports this
            //    since 105; the typeof guard preserves the offset-only path
            //    as a fallback if it's ever missing.
            type CheckVisibility = (opts?: {
              checkOpacity?: boolean;
              checkVisibilityCSS?: boolean;
              contentVisibilityAuto?: boolean;
            }) => boolean;
            const cv = (el as unknown as { checkVisibility?: CheckVisibility }).checkVisibility;
            if (typeof cv === 'function') {
              if (!cv.call(el, {
                checkOpacity:          true,
                checkVisibilityCSS:    true,
                contentVisibilityAuto: true,
              })) return false;
            }

            // 3. Sr-only / off-screen positioning. getBoundingClientRect
            //    reflects transforms and absolute positioning, so an element
            //    pulled left: -9999px or transform: translateX(-100%) reports
            //    a negative right edge.
            const rect = el.getBoundingClientRect();
            if (rect.right <= 0 || rect.bottom <= 0) return false;

            // 4. Tiny clipped elements (Tailwind sr-only is 1x1 with clip).
            if (rect.width <= 1 && rect.height <= 1) return false;

            return true;
          };

          // Body-scoped, cookie-banner descendants excluded.
          // <div>, <nav>, <main>, <svg>, <g>, <path>, <canvas>, <figure>, and
          // <img> elements are excluded — layout/graphics/media primitives
          // whose styles don't represent token-bearing text. Their children
          // are sampled individually (when they have any), so the element
          // itself is skipped to avoid noise from styles that aren't
          // independently meaningful for token compliance.
          // Tag names are compared in lower case because SVG elements return
          // lowercase from `tagName` in HTML documents while HTML elements
          // return uppercase.
          // The Algolia autocomplete and universal-nav-btn subtrees are
          // excluded entirely (3rd-party / shared-nav widgets whose styles
          // come from outside the design system).
          // The ally-skip-button is a visually-hidden skip link.
          const SKIPPED_TAGS = new Set([
            'svg', 'g', 'path', 'main',
            'canvas', 'figure', 'figcaption', 'img', 'hr',
          ]);
          // Text-only elements: paragraph/link/list/heading elements get
          // checked for fonts but not colors. Their color is typically
          // inherited from an HTML ancestor whose value is already covered by
          // that ancestor's check; counting it again on every <p>/<a>/<li>/<h*>
          // inflates the violation count without identifying a new source.
          const FONT_ONLY_TAGS = new Set([
            'a', 'li', 'ul', 'p', 'span', 'section',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          ]);
          const elements = Array.from(document.querySelectorAll<HTMLElement>('body *'))
            .filter(isUserVisible)
            .filter((el) => !SKIPPED_TAGS.has(el.tagName.toLowerCase()))
            .filter((el) => el.getAttribute('data-testid') !== 'ally-skip-button')
            .filter((el) => el.getAttribute('data-testid') !== 'image-shadow')
            .filter((el) => el.getAttribute('data-testid') !== 'copyright-text')
            .filter((el) => el.id !== 'clickable-atom')
            .filter((el) => !el.closest('[data-testid="algolia-autocomplete"]'))
            .filter((el) => !el.closest('[data-testid="open-universal-nav-btn"]'))
            .filter((el) => !isCookieBanner(el))
            .slice(0, 800);

          for (const el of elements) {
            const style = getComputedStyle(el);
            const desc  = describeElement(el);
            const tag   = el.tagName.toLowerCase();

            // Colors — skipped for text-only elements (<a>, <li>, <ul>).
            if (!FONT_ONLY_TAGS.has(tag)) for (const prop of COLOR_PROPS) {
              const hex = rgbToHex(style[prop] ?? '');
              if (!hex) continue;
              if (!colorMap[hex]) colorMap[hex] = { count: 0, properties: [], samples: [] };
              colorMap[hex].count++;
              if (!colorMap[hex].properties.includes(prop)) {
                colorMap[hex].properties.push(prop);
              }
              if (colorMap[hex].samples.length < 3 && !colorMap[hex].samples.includes(desc)) {
                colorMap[hex].samples.push(desc);
              }
            }

            // Font family + weight — only sampled on elements that directly
            // render text. An element "shows text" if it has at least one
            // direct child text node with non-whitespace content. Pure layout
            // containers (whose visible text comes only from descendants) are
            // skipped; their text-bearing descendants get iterated separately
            // and contribute the meaningful typography signal.
            let hasDirectText = false;
            const childNodes = el.childNodes;
            for (let i = 0; i < childNodes.length; i++) {
              const node = childNodes[i];
              if (node.nodeType === 3 /* Node.TEXT_NODE */ &&
                  node.textContent && node.textContent.trim().length > 0) {
                hasDirectText = true;
                break;
              }
            }

            // Use the first declared family (ignore fallbacks). getComputedStyle
            // resolves fontWeight to a numeric string in modern browsers; fall
            // back to keyword mapping for older quirks.
            const family = style.fontFamily
              .split(',')[0]
              .trim()
              .replace(/['"]/g, '')
              .toLowerCase();
            if (family && hasDirectText) {
              const fwRaw  = (style.fontWeight ?? '').toString().toLowerCase();
              const weight = parseInt(fwRaw, 10) || (fwRaw === 'bold' ? 700 : 400);
              const key    = buildFontKey(family, weight);
              // For weight-baked families the rendered weight is incidental —
              // the font face dictates the visual weight. Store 0 as a sentinel
              // so cross-environment diffs (which key on family+weight) agree.
              const isWeightBaked = key.endsWith('|*');
              const storedWeight  = isWeightBaked ? 0 : weight;
              if (!fontMap[key]) {
                fontMap[key] = { fontFamily: family, fontWeight: storedWeight, count: 0, samples: [] };
              }
              fontMap[key].count++;
              if (fontMap[key].samples.length < 3 && !fontMap[key].samples.includes(desc)) {
                fontMap[key].samples.push(desc);
              }
            }
          }

          // Comparison against token sets happens Node-side (below) so a
          // single page evaluation can be re-used against multiple sets.
          return { colorMap, fontMap };
        },
        { weightSuffixPattern: WEIGHT_SUFFIX_PATTERN },
      )
      .catch(() => null);

    if (rawStyles) {
      // Pick the candidate set with the fewest element-level violations
      // (sum of element counts across unknown colors + unknown fonts).
      // Ties go to the first candidate, which keeps the result deterministic
      // when the page's palette matches multiple brand themes equally well.
      const elementScore = (v: DesignTokenViolations): number =>
        v.unknownColors.reduce((s, c) => s + c.count, 0) +
        v.unknownFonts.reduce((s, f) => s + f.count, 0);

      let best: { name: string; violations: DesignTokenViolations; score: number } | null = null;
      const scored: { name: string; violations: DesignTokenViolations; score: number }[] = [];

      for (const candidate of tokenCandidates) {
        const v = computeTokenViolations(rawStyles.colorMap, rawStyles.fontMap, candidate.tokens);
        const score = elementScore(v);
        scored.push({ name: candidate.name, violations: v, score });
        if (!best || score < best.score) {
          best = { name: candidate.name, violations: v, score };
        }
      }

      if (best) {
        designTokenViolations = best.violations;
        matchedTokenSet       = best.name || null;
        matchedTokenSets      = scored.filter(s => s.score === 0).map(s => s.name);
      }
    }
  }

  return {
    url,
    finalUrl,
    statusCode,
    loadError,
    metadata,
    headings,
    images,
    links,
    forms,
    videos,
    consoleEntries,
    performance: performance ?? EMPTY_PERFORMANCE,
    screenshotBase64,
    scriptsCount,
    stylesheetsCount,
    textBlocks,
    axeViolations,
    designTokenViolations,
    matchedTokenSet,
    matchedTokenSets,
    timestamp: new Date().toISOString(),
  };
}
