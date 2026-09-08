import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginToPreview, requireAuthConfig } from '../../utils/auth';

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

// Locale segment pattern: xx-XX (e.g. en-NZ, pt-BR, he-IL)
const LOCALE_RE = /^\/([a-z]{2}-[A-Z]{2})(\/|$)/;
const EXCLUDED_LOCALES = new Set(['en-CA', 'fr-CA']);

// Recipe path segments per language — extend as new locales are found
const RECIPE_PATHS = new Set([
  'recipes',    // English
  'receitas',   // Portuguese
  'recettes',   // French
  'recetas',    // Spanish
  'rezepte',    // German
  'ricette',    // Italian
  'recepten',   // Dutch
  'recepty',    // Czech / Slovak
  'retsepti',   // Russian/Ukrainian (transliterated)
  'recepti',    // Slovenian / Croatian
  'receptury',  // Polish
  'recepten',   // Dutch (duplicate guard)
  'oppskrifter',// Norwegian
  'opskrifter', // Danish
  'recept',     // Swedish / Hungarian
  'recepti',    // Serbian / Bosnian
  'resepti',    // Finnish
]);

const PAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;

interface RecipeResult {
  url: string;
  locale: string;
  recipeName: string | null;
  hasBundleProducts: boolean;
}

/** Extract all <loc> entries from a sitemap XML string. */
function extractLocs(xml: string): string[] {
  return Array.from(new Set(
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim()),
  ));
}

/** Return the locale segment if the URL has a valid locale, null otherwise. */
function extractLocale(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const match = LOCALE_RE.exec(pathname);
    if (!match) return null;
    const locale = match[1];
    if (EXCLUDED_LOCALES.has(locale)) return null;
    return locale;
  } catch {
    return null;
  }
}

/** Return true if any path segment after the locale is a known recipe path.
 *  Handles both /en-NZ/recipes/… and /en-NZ/watties/recipes/… */
function isRecipePage(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const match = LOCALE_RE.exec(pathname);
    if (!match) return false;
    // Check every segment that follows the locale
    const afterLocale = pathname.slice(match[0].length);
    return afterLocale.split('/').some((s) => RECIPE_PATHS.has(s.toLowerCase()));
  } catch {
    return false;
  }
}

test('Audit recipe pages for bundle-products element', async ({ browser }) => {
  test.setTimeout(0); // long-running crawl

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
        // Replace preview host with production host so downstream URLs are canonical.
        locs = rawLocs.map((u) => u.replace(from, to));
        console.log(`[sitemap] ${locs.length} URLs found in fallback (hosts rewritten: ${from} → ${to})`);
      } catch (err) {
        console.error(`[sitemap] Fallback also failed: ${(err as Error).message}`);
      }
    }

    allUrls.push(...locs);
  }

  await seedPage.close();

  // ── 2. Filter to recipe pages with a valid (non-excluded) locale ───────────
  const recipeUrls = allUrls.filter((u) => extractLocale(u) !== null && isRecipePage(u));
  console.log(`\n[filter] ${recipeUrls.length} recipe URLs after filtering.\n`);

  // ── 3. Visit each URL and check for bundle-products element ──────────────
  const results: RecipeResult[] = [];
  let processed = 0;
  const queue = [...recipeUrls];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const page = await ctx.newPage();
    try {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        processed++;
        const locale = extractLocale(url)!;
        const prefix = `[${processed}/${recipeUrls.length}]`;

        try {
          await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

          const hasBundleProducts = await page
            .locator('[data-testid="or-core-bundle-products-flex-test-id"]')
            .count()
            .then((n) => n > 0);

          const recipeName = await page
            .locator('[data-testid="at-core-headline"]')
            .first()
            .textContent({ timeout: 5_000 })
            .then((t) => t?.trim() ?? null)
            .catch(() => null);

          results.push({ url, locale, recipeName, hasBundleProducts });
          const flag = hasBundleProducts ? '✓ bundle' : '–';
          console.log(`${prefix} [${locale}] ${flag} ${url}`);
        } catch (err) {
          const msg = (err as Error).message.split('\n')[0];
          console.log(`${prefix} ✗ ${url} — ${msg}`);
          results.push({ url, locale, recipeName: null, hasBundleProducts: false });
        }
      }
    } finally {
      await page.close();
    }
  });

  await Promise.all(workers);

  // ── 4. Write output JSON ──────────────────────────────────────────────────
  const outDir = path.join(process.cwd(), 'reports', 'audits');
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `bundle-products-audit-${timestamp}.json`);

  const withBundle = results.filter((r) => r.hasBundleProducts);
  const output = {
    generatedAt: new Date().toISOString(),
    totalRecipeUrlsChecked: results.length,
    pagesWithBundleProducts: withBundle.length,
    results: withBundle.map(({ url, locale, recipeName }) => ({ url, locale, recipeName })),
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n' + '='.repeat(72));
  console.log(`BUNDLE-PRODUCTS AUDIT COMPLETE`);
  console.log('='.repeat(72));
  console.log(`Recipe pages checked : ${results.length}`);
  console.log(`Pages with element   : ${withBundle.length}`);
  console.log(`Report saved to      : ${outPath}`);
  console.log('='.repeat(72) + '\n');

  await ctx.close();
});
