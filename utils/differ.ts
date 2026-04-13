import { PageAnalysis, HeadingInfo, ConsoleEntry, PerformanceMetrics } from './analyzer';

export interface ValueDiff<T> {
  preview: T;
  production: T;
  isDifferent: boolean;
}

export interface PerfDiff {
  preview: number;
  production: number;
  deltaMs: number;
  deltaPct: number;
}

export interface SetDiff {
  onlyInPreview: string[];
  onlyInProduction: string[];
  matchCount: number;
  isDifferent: boolean;
}

export interface PageDiff {
  statusCode: ValueDiff<number>;
  /** Path-only comparison (host excluded — preview and production hosts always differ) */
  finalUrlPath: ValueDiff<string>;
  metadata: {
    title: ValueDiff<string>;
    description: ValueDiff<string>;
    /** Path-only (host excluded) */
    canonical: ValueDiff<string>;
    ogTitle: ValueDiff<string>;
    ogDescription: ValueDiff<string>;
    /** Path-only (host excluded) */
    ogImage: ValueDiff<string>;
    keywords: ValueDiff<string>;
    robots: ValueDiff<string>;
    language: ValueDiff<string>;
    viewport: ValueDiff<string>;
  };
  headingsCount: ValueDiff<number>;
  imagesCount: ValueDiff<number>;
  imagesWithoutAlt: ValueDiff<number>;
  linksCount: ValueDiff<number>;
  formsCount: ValueDiff<number>;
  scriptsCount: ValueDiff<number>;
  stylesheetsCount: ValueDiff<number>;
  performance: {
    preview: PerformanceMetrics;
    production: PerformanceMetrics;
    loadTime: PerfDiff;
    domContentLoaded: PerfDiff;
    firstContentfulPaint: PerfDiff;
    responseEnd: PerfDiff;
    transferSize: PerfDiff;
  };
  consoleErrors: {
    preview: ConsoleEntry[];
    production: ConsoleEntry[];
  };
  headings: {
    preview: HeadingInfo[];
    production: HeadingInfo[];
    onlyInPreview: HeadingInfo[];
    onlyInProduction: HeadingInfo[];
    isDifferent: boolean;
  };
  content: {
    text: SetDiff;
    images: SetDiff;
    links: SetDiff;
  };
  totalDifferences: number;
  criticalDifferences: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function vd<T>(preview: T, production: T): ValueDiff<T> {
  return { preview, production, isDifferent: preview !== production };
}

function pd(previewVal: number, productionVal: number): PerfDiff {
  const delta = productionVal - previewVal;
  const base = previewVal || 1;
  return {
    preview: previewVal,
    production: productionVal,
    deltaMs: delta,
    deltaPct: Math.round((delta / base) * 100),
  };
}

/**
 * Strips the host from a URL and returns only the path + query string.
 * Used so that preview and production URL fields are compared without their
 * different hostnames causing false positives.
 */
function urlPath(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    // Already a relative path, or malformed — return as-is
    return url;
  }
}

function setDiff(previewSet: Set<string>, productionSet: Set<string>): SetDiff {
  const onlyInPreview = [...previewSet].filter((v) => !productionSet.has(v));
  const onlyInProduction = [...productionSet].filter((v) => !previewSet.has(v));
  const matchCount = [...previewSet].filter((v) => productionSet.has(v)).length;
  return {
    onlyInPreview,
    onlyInProduction,
    matchCount,
    isDifferent: onlyInPreview.length > 0 || onlyInProduction.length > 0,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function diffAnalyses(preview: PageAnalysis, production: PageAnalysis): PageDiff {
  const metadata = {
    title: vd(preview.metadata.title, production.metadata.title),
    description: vd(preview.metadata.description, production.metadata.description),
    canonical: vd(urlPath(preview.metadata.canonical), urlPath(production.metadata.canonical)),
    ogTitle: vd(preview.metadata.ogTitle, production.metadata.ogTitle),
    ogDescription: vd(preview.metadata.ogDescription, production.metadata.ogDescription),
    ogImage: vd(urlPath(preview.metadata.ogImage), urlPath(production.metadata.ogImage)),
    keywords: vd(preview.metadata.keywords, production.metadata.keywords),
    robots: vd(preview.metadata.robots, production.metadata.robots),
    language: vd(preview.metadata.language, production.metadata.language),
    viewport: vd(preview.metadata.viewport, production.metadata.viewport),
  };

  const previewHeadingKeys = new Set(preview.headings.map((h) => `h${h.level}:${h.text}`));
  const productionHeadingKeys = new Set(production.headings.map((h) => `h${h.level}:${h.text}`));

  const headings = {
    preview: preview.headings,
    production: production.headings,
    onlyInPreview: preview.headings.filter((h) => !productionHeadingKeys.has(`h${h.level}:${h.text}`)),
    onlyInProduction: production.headings.filter((h) => !previewHeadingKeys.has(`h${h.level}:${h.text}`)),
    isDifferent: JSON.stringify(preview.headings) !== JSON.stringify(production.headings),
  };

  const statusCode = vd(preview.statusCode, production.statusCode);

  // Compare only the path — hosts always differ between environments
  const finalUrlPath = vd(urlPath(preview.finalUrl), urlPath(production.finalUrl));

  const headingsCount = vd(preview.headings.length, production.headings.length);
  const imagesCount = vd(preview.images.length, production.images.length);
  const imagesWithoutAlt = vd(
    preview.images.filter((i) => !i.hasAlt).length,
    production.images.filter((i) => !i.hasAlt).length,
  );
  const linksCount = vd(preview.links.length, production.links.length);
  const formsCount = vd(preview.forms.length, production.forms.length);
  const scriptsCount = vd(preview.scriptsCount, production.scriptsCount);
  const stylesheetsCount = vd(preview.stylesheetsCount, production.stylesheetsCount);

  const performance = {
    preview: preview.performance,
    production: production.performance,
    loadTime: pd(preview.performance.loadTime, production.performance.loadTime),
    domContentLoaded: pd(preview.performance.domContentLoaded, production.performance.domContentLoaded),
    firstContentfulPaint: pd(preview.performance.firstContentfulPaint, production.performance.firstContentfulPaint),
    responseEnd: pd(preview.performance.responseEnd, production.performance.responseEnd),
    transferSize: pd(preview.performance.transferSize, production.performance.transferSize),
  };

  // ── Content diffs ─────────────────────────────────────────────────────────
  // Text: deduplicated visible text blocks
  const previewTexts = new Set(preview.textBlocks);
  const productionTexts = new Set(production.textBlocks);
  const textDiff = setDiff(previewTexts, productionTexts);

  // Images: compare by path only (different hosts for same image shouldn't be flagged)
  const previewImagePaths = new Set(
    preview.images.map((img) => urlPath(img.src)).filter(Boolean),
  );
  const productionImagePaths = new Set(
    production.images.map((img) => urlPath(img.src)).filter(Boolean),
  );
  const imageDiff = setDiff(previewImagePaths, productionImagePaths);

  // Links: compare by path only
  const previewLinkPaths = new Set(
    preview.links.map((l) => urlPath(l.href)).filter((p) => p && p !== '/'),
  );
  const productionLinkPaths = new Set(
    production.links.map((l) => urlPath(l.href)).filter((p) => p && p !== '/'),
  );
  const linkDiff = setDiff(previewLinkPaths, productionLinkPaths);

  const content = {
    text: textDiff,
    images: imageDiff,
    links: linkDiff,
  };

  // ── Difference counts ─────────────────────────────────────────────────────
  const metaDiffs = Object.values(metadata).filter((d) => d.isDifferent).length;
  const structDiffs = [headingsCount, imagesCount, linksCount, formsCount, scriptsCount, stylesheetsCount].filter(
    (d) => d.isDifferent,
  ).length;
  const headingsDiff = headings.isDifferent ? 1 : 0;
  const statusDiff = statusCode.isDifferent ? 1 : 0;
  const contentDiffs =
    (textDiff.isDifferent ? 1 : 0) +
    (imageDiff.isDifferent ? 1 : 0) +
    (linkDiff.isDifferent ? 1 : 0);

  const totalDifferences = metaDiffs + structDiffs + headingsDiff + statusDiff + contentDiffs;

  const criticalDifferences =
    statusDiff +
    (metadata.title.isDifferent ? 1 : 0) +
    (metadata.description.isDifferent ? 1 : 0) +
    (metadata.robots.isDifferent ? 1 : 0);

  return {
    statusCode,
    finalUrlPath,
    metadata,
    headingsCount,
    imagesCount,
    imagesWithoutAlt,
    linksCount,
    formsCount,
    scriptsCount,
    stylesheetsCount,
    performance,
    consoleErrors: {
      preview: preview.consoleEntries.filter((e) => ['error', 'warning'].includes(e.type)),
      production: production.consoleEntries.filter((e) => ['error', 'warning'].includes(e.type)),
    },
    headings,
    content,
    totalDifferences,
    criticalDifferences,
  };
}
