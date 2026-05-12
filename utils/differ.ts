import { PageAnalysis, HeadingInfo, ConsoleEntry, PerformanceMetrics, AxeViolation, VideoInfo, DesignTokenViolations } from './analyzer';

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
  videosCount: ValueDiff<number>;
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
    videos: {
      preview: VideoInfo[];
      production: VideoInfo[];
      onlyInPreview: VideoInfo[];
      onlyInProduction: VideoInfo[];
      inBoth: string[];
      isDifferent: boolean;
    };
  };
  axe: {
    preview: AxeViolation[];
    production: AxeViolation[];
    /** Violations (by rule id) present only on preview */
    onlyInPreview: AxeViolation[];
    /** Violations (by rule id) present only on production */
    onlyInProduction: AxeViolation[];
    /** Rule ids with violations on both sides */
    inBoth: string[];
  };
  /**
   * Design-token compliance comparison.
   * null when no design tokens were provided during analysis.
   */
  designTokens: {
    preview:    DesignTokenViolations | null;
    production: DesignTokenViolations | null;
    /** Unknown colors present on preview but not on production */
    colorsOnlyInPreview: string[];
    /** Unknown colors present on production but not on preview */
    colorsOnlyInProduction: string[];
    /** Unknown colors present on both sides */
    colorsInBoth: string[];
    /** Unknown fonts present on preview but not on production */
    fontsOnlyInPreview: string[];
    /** Unknown fonts present on production but not on preview */
    fontsOnlyInProduction: string[];
    /** Unknown fonts present on both sides */
    fontsInBoth: string[];
  } | null;
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

/**
 * Stable key for a video used in set-comparison.
 * Platform-specific IDs (YouTube, Vimeo, Wistia) are used directly so that the
 * same video hosted on different environments is treated as identical.
 * For native <video> and generic iframes the host-stripped path is used.
 */
function videoKey(v: VideoInfo): string {
  if (['youtube', 'vimeo', 'wistia'].includes(v.platform)) {
    return `${v.platform}:${v.videoId}`;
  }
  return `${v.platform}:${urlPath(v.src)}`;
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
  const videosCount = vd(preview.videos.length, production.videos.length);

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

  // Videos: compare by stable platform key (ID for YouTube/Vimeo/Wistia, path for others)
  const previewVideoKeys   = new Map(preview.videos.map((v) => [videoKey(v), v]));
  const productionVideoKeys = new Map(production.videos.map((v) => [videoKey(v), v]));
  const videosDiff = {
    preview:          preview.videos,
    production:       production.videos,
    onlyInPreview:    preview.videos.filter((v) => !productionVideoKeys.has(videoKey(v))),
    onlyInProduction: production.videos.filter((v) => !previewVideoKeys.has(videoKey(v))),
    inBoth:           [...previewVideoKeys.keys()].filter((k) => productionVideoKeys.has(k)),
    isDifferent:      false,
  };
  videosDiff.isDifferent = videosDiff.onlyInPreview.length > 0 || videosDiff.onlyInProduction.length > 0;

  const content = {
    text: textDiff,
    images: imageDiff,
    links: linkDiff,
    videos: videosDiff,
  };

  // ── Accessibility diff ────────────────────────────────────────────────────
  const previewViolationIds  = new Set(preview.axeViolations.map((v) => v.id));
  const productionViolationIds = new Set(production.axeViolations.map((v) => v.id));

  const axe = {
    preview:         preview.axeViolations,
    production:      production.axeViolations,
    onlyInPreview:   preview.axeViolations.filter((v) => !productionViolationIds.has(v.id)),
    onlyInProduction: production.axeViolations.filter((v) => !previewViolationIds.has(v.id)),
    inBoth:          [...previewViolationIds].filter((id) => productionViolationIds.has(id)),
  };

  // ── Design-token diff ────────────────────────────────────────────────────
  let designTokensDiff: PageDiff['designTokens'] = null;

  if (preview.designTokenViolations || production.designTokenViolations) {
    const previewColors   = new Set((preview.designTokenViolations?.unknownColors   ?? []).map((c) => c.color));
    const productionColors = new Set((production.designTokenViolations?.unknownColors ?? []).map((c) => c.color));
    const previewFonts    = new Set((preview.designTokenViolations?.unknownFonts    ?? []).map((f) => `${f.fontFamily}|${f.fontWeight}`));
    const productionFonts  = new Set((production.designTokenViolations?.unknownFonts  ?? []).map((f) => `${f.fontFamily}|${f.fontWeight}`));

    designTokensDiff = {
      preview:    preview.designTokenViolations,
      production: production.designTokenViolations,
      colorsOnlyInPreview:    [...previewColors].filter((c) => !productionColors.has(c)),
      colorsOnlyInProduction: [...productionColors].filter((c) => !previewColors.has(c)),
      colorsInBoth:           [...previewColors].filter((c) => productionColors.has(c)),
      fontsOnlyInPreview:    [...previewFonts].filter((f) => !productionFonts.has(f)),
      fontsOnlyInProduction: [...productionFonts].filter((f) => !previewFonts.has(f)),
      fontsInBoth:           [...previewFonts].filter((f) => productionFonts.has(f)),
    };
  }

  // ── Difference counts ─────────────────────────────────────────────────────
  const metaDiffs = Object.values(metadata).filter((d) => d.isDifferent).length;
  const structDiffs = [headingsCount, imagesCount, linksCount, formsCount, scriptsCount, stylesheetsCount, videosCount].filter(
    (d) => d.isDifferent,
  ).length;
  const headingsDiff = headings.isDifferent ? 1 : 0;
  const statusDiff = statusCode.isDifferent ? 1 : 0;
  const contentDiffs =
    (textDiff.isDifferent ? 1 : 0) +
    (imageDiff.isDifferent ? 1 : 0) +
    (linkDiff.isDifferent ? 1 : 0) +
    (videosDiff.isDifferent ? 1 : 0);
  // Violations unique to one side count as differences; violations on both sides are shared issues
  const axeUniqueDiffs = axe.onlyInPreview.length + axe.onlyInProduction.length;
  const axeCriticalUnique = [...axe.onlyInPreview, ...axe.onlyInProduction].filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  ).length;

  const totalDifferences = metaDiffs + structDiffs + headingsDiff + statusDiff + contentDiffs + axeUniqueDiffs;

  const criticalDifferences =
    statusDiff +
    (metadata.title.isDifferent ? 1 : 0) +
    (metadata.description.isDifferent ? 1 : 0) +
    (metadata.robots.isDifferent ? 1 : 0) +
    axeCriticalUnique;

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
    videosCount,
    performance,
    consoleErrors: {
      preview: preview.consoleEntries.filter((e) => ['error', 'warning'].includes(e.type)),
      production: production.consoleEntries.filter((e) => ['error', 'warning'].includes(e.type)),
    },
    headings,
    content,
    axe,
    designTokens: designTokensDiff,
    totalDifferences,
    criticalDifferences,
  };
}
