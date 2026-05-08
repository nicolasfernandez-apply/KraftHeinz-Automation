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

/** Nested color/typography token structure as produced by refresh-tokens.mjs */
export interface DesignTokens {
  colors:     Record<string, unknown>;
  typography: Record<string, unknown>;
}

/** A color found on the page that is not present in the design token palette. */
export interface ColorViolation {
  color:      string;   // lowercase hex, e.g. "#ff0000"
  count:      number;   // number of elements using this color
  properties: string[]; // CSS properties where it was found
  samples:    string[]; // up to 3 example element descriptors (tag#id.class) that use this color
}

/** A font family found on the page that is not in the design token set. */
export interface FontViolation {
  fontFamily: string;
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
   */
  designTokenViolations: DesignTokenViolations | null;
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
 * Collect every distinct fontFamily value from a nested typography token object.
 * Works by looking for objects that have a `fontFamily` string property.
 */
function flattenTokenFonts(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.fontFamily === 'string') {
      out.add(rec.fontFamily.toLowerCase());
    }
    for (const v of Object.values(rec)) flattenTokenFonts(v, out);
  }
  return out;
}

export async function analyzePage(
  page: Page,
  url: string,
  screenshotPath: string,
  designTokens?: DesignTokens | null,
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

  const headings = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map((el) => ({
          level: parseInt(el.tagName[1], 10),
          text: (el as HTMLElement).innerText.trim().substring(0, 200),
        }))
        .filter((h) => h.text),
    )
    .catch(() => [] as HeadingInfo[]);

  const images = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('img'))
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
    )
    .catch(() => [] as ImageInfo[]);

  const links = await page
    .evaluate((pageUrl: string) => {
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
    }, url)
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
    .evaluate(() => {
      const items: Array<{ platform: string; src: string; videoId: string; title: string }> = [];

      document.querySelectorAll('video').forEach((el) => {
        const v = el as HTMLVideoElement;
        // Prefer the resolved .src property; fall back to the first <source> child
        const src = v.src || (v.querySelector('source') as HTMLSourceElement | null)?.src || '';
        if (!src) return;
        items.push({ platform: 'native', src, videoId: src, title: v.getAttribute('title') || '' });
      });

      return items;
    })
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
    .evaluate(() => {
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
        // Skip elements that themselves contain block children (avoids duplicating parent text)
        if (el.querySelector('p, li, blockquote, div')) continue;
        const text = (el as HTMLElement).innerText
          ?.replace(/\s+/g, ' ')
          .trim()
          .substring(0, 400);
        if (text && text.length >= 15 && !seen.has(text)) {
          seen.add(text);
          blocks.push(text);
        }
      }
      return blocks.slice(0, 500);
    })
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

  if (designTokens) {
    const validColors = [...flattenTokenColors(designTokens.colors)];
    const validFonts  = [...flattenTokenFonts(designTokens.typography)];

    designTokenViolations = await page
      .evaluate(
        ({ validColorsArr, validFontsArr }) => {
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
          const COLOR_PROPS = ['backgroundColor', 'color', 'borderTopColor'] as const;

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
          const fontMap:  Record<string, { count: number; samples: string[] }> = {};

          // Body-scoped, cookie-banner descendants excluded.
          const elements = Array.from(document.querySelectorAll<HTMLElement>('body *'))
            .filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0) // visible only
            .filter((el) => !isCookieBanner(el))
            .slice(0, 800);

          for (const el of elements) {
            const style = getComputedStyle(el);
            const desc  = describeElement(el);

            // Colors
            for (const prop of COLOR_PROPS) {
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

            // Font family — use the first declared family (ignore fallbacks)
            const ff = style.fontFamily
              .split(',')[0]
              .trim()
              .replace(/['"]/g, '')
              .toLowerCase();
            if (ff) {
              if (!fontMap[ff]) fontMap[ff] = { count: 0, samples: [] };
              fontMap[ff].count++;
              if (fontMap[ff].samples.length < 3 && !fontMap[ff].samples.includes(desc)) {
                fontMap[ff].samples.push(desc);
              }
            }
          }

          // ── Compare against token sets ───────────────────────────────────
          const tokenColorSet = new Set(validColorsArr);
          const tokenFontSet  = new Set(validFontsArr);

          const unknownColors = Object.entries(colorMap)
            .filter(([hex]) => !tokenColorSet.has(hex))
            .map(([color, data]) => ({
              color,
              count:      data.count,
              properties: data.properties,
              samples:    data.samples,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50); // cap to keep report readable

          const compliantColorCount = Object.keys(colorMap)
            .filter((hex) => tokenColorSet.has(hex)).length;

          const unknownFonts = Object.entries(fontMap)
            .filter(([ff]) => !tokenFontSet.has(ff))
            .map(([fontFamily, data]) => ({
              fontFamily,
              count:   data.count,
              samples: data.samples,
            }))
            .sort((a, b) => b.count - a.count);

          const compliantFontCount = Object.keys(fontMap)
            .filter((ff) => tokenFontSet.has(ff)).length;

          return { unknownColors, compliantColorCount, unknownFonts, compliantFontCount };
        },
        { validColorsArr: validColors, validFontsArr: validFonts },
      )
      .catch(() => null);
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
    timestamp: new Date().toISOString(),
  };
}
