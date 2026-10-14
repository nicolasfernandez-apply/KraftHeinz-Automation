import { Page } from '@playwright/test';

/** Where on the page an asset reference was found. */
export type AssetKind = 'image' | 'video';

export interface PageAsset {
  kind: AssetKind;
  /** Absolute URL of the asset source. */
  url: string;
  /** DOM origin of the reference, e.g. "img[src]", "source[srcset]", "video[poster]". */
  source: string;
  /** Short CSS-ish path of the owning element, for locating it on the page. */
  selector: string;
  /** alt / aria-label / title, when the element carries one. */
  label: string;
}

/**
 * One distinct asset URL, with every reference to it on the page folded in.
 * A single image is typically referenced many times (src + currentSrc + each
 * srcset candidate + a CSS background), so the report lists the URL once.
 */
export interface AssetResult {
  kind: AssetKind;
  /** Absolute URL of the asset source. */
  url: string;
  /** Every DOM origin this URL was found in, e.g. ["img[src]", "img[srcset]"]. */
  sources: string[];
  /** Every element that references this URL. */
  selectors: string[];
  /** Distinct alt / aria-label / title values seen on those elements. */
  labels: string[];
  /** How many references to this URL were found on the page. */
  occurrences: number;
  passed: boolean;
  /** The target string that matched, when `passed`. */
  matchedTarget?: string;
}

export interface DamValidationResult {
  name: string;
  url: string;
  environment: string;
  targetUrls: string[];
  generatedAt: string;
  passed: AssetResult[];
  failed: AssetResult[];
  /** Assets skipped via the config `ignore` list — reported but not graded. */
  ignored: AssetResult[];
  /** Full-page screenshot as a base64 PNG (embedded in the HTML report). */
  screenshotBase64?: string;
}

/**
 * Collects every image and video source referenced by the rendered page:
 * `img` (src/currentSrc/srcset), `picture > source`, `video` (src/currentSrc/poster),
 * `video > source`, and CSS `background-image` / `content` URLs from computed styles.
 *
 * Relative URLs are resolved against the document, and duplicates (same URL from the
 * same element and attribute) are collapsed.
 */
export async function collectPageAssets(page: Page): Promise<PageAsset[]> {
  return page.evaluate(() => {
    const out: {
      kind: 'image' | 'video';
      url: string;
      source: string;
      selector: string;
      label: string;
    }[] = [];
    const seen = new Set<string>();

    function describe(el: Element): string {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    function labelOf(el: Element): string {
      return (
        el.getAttribute('alt') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      ).replace(/\s+/g, ' ').trim();
    }

    function absolute(raw: string): string | null {
      const value = raw.trim();
      if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return null;
      }
    }

    function add(kind: 'image' | 'video', raw: string, source: string, el: Element) {
      const url = absolute(raw);
      if (!url) return;
      const key = `${url}\u0000${source}\u0000${describe(el)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, url, source, selector: describe(el), label: labelOf(el) });
    }

    /**
     * Parses a srcset the way the HTML spec does: a candidate's URL runs to the
     * next whitespace, and only then do commas separate candidates. Splitting on
     * "," alone would shred URLs that legitimately contain one, such as
     * Cloudinary transforms ("…/c_limit,w_96/v1/image").
     * "a.jpg 1x, b.jpg 2x" → ["a.jpg", "b.jpg"]
     */
    function addSrcset(kind: 'image' | 'video', srcset: string, source: string, el: Element) {
      let pos = 0;
      while (pos < srcset.length) {
        while (pos < srcset.length && /[\s,]/.test(srcset[pos])) pos++;
        const start = pos;
        while (pos < srcset.length && !/\s/.test(srcset[pos])) pos++;
        let url = srcset.slice(start, pos);
        if (!url) break;

        if (url.endsWith(',')) {
          // Candidate had no descriptor — the trailing comma is the separator.
          url = url.replace(/,+$/, '');
        } else {
          // Skip this candidate's descriptor, up to the next separating comma.
          const nextComma = srcset.indexOf(',', pos);
          pos = nextComma === -1 ? srcset.length : nextComma + 1;
        }

        if (url) add(kind, url, source, el);
      }
    }

    for (const img of Array.from(document.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      if (src) add('image', src, 'img[src]', img);
      if (img.currentSrc) add('image', img.currentSrc, 'img[currentSrc]', img);
      const srcset = img.getAttribute('srcset');
      if (srcset) addSrcset('image', srcset, 'img[srcset]', img);
      // Common lazy-loading attributes — the real source until the image enters view.
      for (const attr of ['data-src', 'data-lazy-src', 'data-original']) {
        const value = img.getAttribute(attr);
        if (value) add('image', value, `img[${attr}]`, img);
      }
      const dataSrcset = img.getAttribute('data-srcset');
      if (dataSrcset) addSrcset('image', dataSrcset, 'img[data-srcset]', img);
    }

    for (const source of Array.from(document.querySelectorAll('picture source'))) {
      const srcset = source.getAttribute('srcset');
      if (srcset) addSrcset('image', srcset, 'source[srcset]', source);
      const src = source.getAttribute('src');
      if (src) add('image', src, 'source[src]', source);
    }

    for (const video of Array.from(document.querySelectorAll('video'))) {
      const src = video.getAttribute('src');
      if (src) add('video', src, 'video[src]', video);
      if (video.currentSrc) add('video', video.currentSrc, 'video[currentSrc]', video);
      const poster = video.getAttribute('poster');
      if (poster) add('image', poster, 'video[poster]', video);
      for (const attr of ['data-src', 'data-video-src']) {
        const value = video.getAttribute(attr);
        if (value) add('video', value, `video[${attr}]`, video);
      }
      for (const s of Array.from(video.querySelectorAll('source'))) {
        const sSrc = s.getAttribute('src');
        if (sSrc) add('video', sSrc, 'video source[src]', s);
      }
    }

    // Videos embedded as iframes (YouTube/Vimeo/DAM players).
    for (const frame of Array.from(document.querySelectorAll('iframe[src]'))) {
      const src = frame.getAttribute('src')!;
      if (/video|player|youtube|vimeo|scene7|brightcove/i.test(src)) {
        add('video', src, 'iframe[src]', frame);
      }
    }

    // CSS background images — hero banners are often set this way.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const match of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
        add('image', match[2], 'css[background-image]', el);
      }
    }

    return out;
  });
}

/**
 * Folds every reference to the same asset URL into a single entry, keeping the
 * union of the DOM origins, elements and labels and counting the references.
 * The same image usually appears as src + currentSrc + several srcset candidates,
 * which would otherwise fill the report with duplicates of one asset.
 */
export function groupAssetsByUrl(assets: PageAsset[]): Omit<AssetResult, 'passed' | 'matchedTarget'>[] {
  const groups = new Map<string, Omit<AssetResult, 'passed' | 'matchedTarget'>>();

  for (const asset of assets) {
    const key = asset.url.toLowerCase();
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        kind: asset.kind,
        url: asset.url,
        sources: [asset.source],
        selectors: [asset.selector],
        labels: asset.label ? [asset.label] : [],
        occurrences: 1,
      });
      continue;
    }

    existing.occurrences++;
    if (!existing.sources.includes(asset.source)) existing.sources.push(asset.source);
    if (!existing.selectors.includes(asset.selector)) existing.selectors.push(asset.selector);
    if (asset.label && !existing.labels.includes(asset.label)) existing.labels.push(asset.label);
    // A URL referenced as both a poster and a video source is a video.
    if (asset.kind === 'video') existing.kind = 'video';
  }

  return [...groups.values()];
}

/**
 * Groups assets by URL, then splits them into those whose URL contains one of the
 * target strings and those that do not. Matching is a case-insensitive substring
 * test, so partial targets such as "scene7.com" or "/is/image/" are valid.
 */
export function classifyAssets(assets: PageAsset[], targetUrls: string[], ignore: string[] = []): {
  passed: AssetResult[];
  failed: AssetResult[];
  ignored: AssetResult[];
} {
  const normalizedTargets = targetUrls.map((t) => ({ raw: t, lower: t.toLowerCase() }));
  const normalizedIgnore = ignore.map((i) => i.toLowerCase()).filter(Boolean);
  const passed: AssetResult[] = [];
  const failed: AssetResult[] = [];
  const ignored: AssetResult[] = [];

  for (const asset of groupAssetsByUrl(assets)) {
    const lower = asset.url.toLowerCase();
    if (normalizedIgnore.some((i) => lower.includes(i))) {
      ignored.push({ ...asset, passed: false });
      continue;
    }
    const hit = normalizedTargets.find((t) => lower.includes(t.lower));
    if (hit) passed.push({ ...asset, passed: true, matchedTarget: hit.raw });
    else failed.push({ ...asset, passed: false });
  }

  // Most-referenced first, so the widest-reaching problems head the report.
  const byOccurrences = (a: AssetResult, b: AssetResult) =>
    b.occurrences - a.occurrences || a.url.localeCompare(b.url);

  return {
    passed: passed.sort(byOccurrences),
    failed: failed.sort(byOccurrences),
    ignored: ignored.sort(byOccurrences),
  };
}
