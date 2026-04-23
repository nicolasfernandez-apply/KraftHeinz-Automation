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

export async function analyzePage(
  page: Page,
  url: string,
  screenshotPath: string,
): Promise<PageAnalysis> {
  const consoleEntries: ConsoleEntry[] = [];

  page.on('console', (msg) => {
    consoleEntries.push({ type: msg.type(), text: msg.text() });
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
      Array.from(document.querySelectorAll('img')).map((img) => ({
        src: img.getAttribute('src') || '',
        alt: img.alt || '',
        hasAlt: img.hasAttribute('alt') && img.alt.trim() !== '',
      })),
    )
    .catch(() => [] as ImageInfo[]);

  const links = await page
    .evaluate((pageUrl: string) => {
      let pageOrigin = '';
      try {
        pageOrigin = new URL(pageUrl).origin;
      } catch {}
      return Array.from(document.querySelectorAll('a[href]'))
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
        .filter((l) => l.href && l.href !== '#' && !l.href.startsWith('javascript:'));
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
  const textBlocks = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const blocks: string[] = [];
      const elements = Array.from(document.querySelectorAll(
        'p, li, td, th, blockquote, figcaption, label, caption, dt, dd',
      ));
      for (const el of elements) {
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
    const axeResults = await new AxeBuilder({ page }).analyze();
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
    timestamp: new Date().toISOString(),
  };
}
