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

const LOCALE_RE = /^\/([a-z]{2}-[A-Z]{2})(\/|$)/;

const RECIPE_PATHS = new Set([
  'recipes',
  'receitas',
  'recettes',
  'recetas',
  'rezepte',
  'ricette',
  'recepten',
  'recepty',
  'retsepti',
  'recepti',
  'receptury',
  'oppskrifter',
  'opskrifter',
  'recept',
  'resepti',
]);

const PAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 5;

type IssueType = 'No linked products' | 'Only linked products outside recipe brand';

interface RecipeIssue {
  url: string;
  locale: string | null;
  brand: string | null;
  recipeName: string | null;
  issueType: IssueType;
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

/** True if the URL contains a recipe path segment (listing OR detail page). */
function isRecipePage(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const afterLocale = LOCALE_RE.exec(pathname)
      ? pathname.slice(LOCALE_RE.exec(pathname)![0].length)
      : pathname.slice(1);
    return afterLocale.split('/').some((s) => RECIPE_PATHS.has(s.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Returns false for recipe listing/root pages, i.e. URLs where the recipe
 * path segment is the last meaningful segment (nothing after it).
 * e.g. /en-NZ/recipes, /en-NZ/watties/recipes, /recettes — all excluded.
 */
function isRecipeDetailPage(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').map((s) => s.toLowerCase()).filter(Boolean);
    const recipeIdx = segments.findLastIndex((s) => RECIPE_PATHS.has(s));
    if (recipeIdx === -1) return false;
    // There must be at least one non-empty segment after the recipe segment
    return recipeIdx < segments.length - 1;
  } catch {
    return false;
  }
}

/**
 * Derives the brand slug for a given recipe URL.
 *
 * - heinz.com       → always "heinz"
 * - kraftheinz.com  → segment immediately after the locale (xx-XX), or the
 *                     first path segment when there is no locale (US URLs).
 *                     Returns null when the segment is itself a recipe path
 *                     (meaning there is no brand prefix in the URL).
 */
function extractBrand(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url);

    if (hostname.includes('heinz.com') && !hostname.includes('kraftheinz')) {
      return 'heinz';
    }

    // kraftheinz.com — find the segment right after the locale, or the first segment
    const localeMatch = LOCALE_RE.exec(pathname);
    const afterLocale = localeMatch
      ? pathname.slice(localeMatch[0].length)
      : pathname.slice(1); // US: no locale prefix

    const firstSegment = afterLocale.split('/')[0].toLowerCase();

    // If the first segment is a recipe path, there's no brand in the URL
    if (!firstSegment || RECIPE_PATHS.has(firstSegment)) return null;

    return firstSegment;
  } catch {
    return null;
  }
}

/**
 * Returns true if the href of a product link belongs to the recipe's brand.
 * For heinz, any link pointing to the heinz.com hostname is considered on-brand.
 * For all other brands, the brand slug must appear as a path segment in the href.
 */
function linkBelongsToBrand(href: string, brand: string): boolean {
  try {
    const parsed = new URL(href, 'https://placeholder.com');
    if (brand === 'heinz') {
      return parsed.hostname.includes('heinz.com') && !parsed.hostname.includes('kraftheinz');
    }
    return parsed.pathname.split('/').some((s) => s.toLowerCase() === brand);
  } catch {
    return href.split('/').some((s) => s.toLowerCase() === brand);
  }
}

test('Audit recipe pages for missing or off-brand linked products in ingredients', async ({ browser }) => {
  test.setTimeout(0);

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

  const recipeUrls = allUrls.filter((u) => isRecipeDetailPage(u));
  console.log(`\n[filter] ${recipeUrls.length} recipe URLs after filtering.\n`);

  const issues: RecipeIssue[] = [];
  let processed = 0;
  const queue = [...recipeUrls];

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    const page = await ctx.newPage();
    try {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        processed++;
        const locale = extractLocale(url);
        const brand = extractBrand(url);
        const prefix = `[${processed}/${recipeUrls.length}]`;

        try {
          await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

          const recipeName = await page
            .locator('[data-testid="at-core-headline"]')
            .first()
            .textContent({ timeout: 5_000 })
            .then((t) => t?.trim() ?? null)
            .catch(() => null);

          const hasIngredientsContainer = await page
            .locator('[data-testid="ingredients-container"]')
            .count()
            .then((n) => n > 0);

          if (!hasIngredientsContainer) {
            console.log(`${prefix} – [${locale}] no ingredients container, skipping — ${url}`);
            continue;
          }

          // Collect all <a href> values inside the ingredients container
          const hrefs: string[] = await page
            .locator('[data-testid="ingredients-container"] a[href]')
            .evaluateAll((anchors) =>
              anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean),
            );

          let issueType: IssueType | null = null;

          if (hrefs.length === 0) {
            issueType = 'No linked products';
          } else if (brand !== null) {
            const hasBrandLink = hrefs.some((href) => linkBelongsToBrand(href, brand));
            if (!hasBrandLink) {
              issueType = 'Only linked products outside recipe brand';
            }
          }

          if (issueType) {
            issues.push({ url, locale, brand, recipeName, issueType });
            console.log(`${prefix} ✗ [${locale}] ${issueType} — ${url}`);
          } else {
            console.log(`${prefix} ✓ [${locale}] ${url}`);
          }
        } catch (err) {
          const msg = (err as Error).message.split('\n')[0];
          console.log(`${prefix} ✗ ${url} — ${msg}`);
        }
      }
    } finally {
      await page.close();
    }
  });

  await Promise.all(workers);

  const outDir = path.join(process.cwd(), 'reports', 'audits');
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `recipe-linked-products-audit-${timestamp}.json`);

  const output = {
    generatedAt: new Date().toISOString(),
    totalRecipeUrlsChecked: processed,
    recipesWithIssues: issues.length,
    results: issues,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n' + '='.repeat(72));
  console.log('RECIPE LINKED-PRODUCTS AUDIT COMPLETE');
  console.log('='.repeat(72));
  console.log(`Recipe pages checked   : ${processed}`);
  console.log(`Recipes with issues    : ${issues.length}`);
  console.log(`Report saved to        : ${outPath}`);
  console.log('='.repeat(72) + '\n');

  await ctx.close();
});
