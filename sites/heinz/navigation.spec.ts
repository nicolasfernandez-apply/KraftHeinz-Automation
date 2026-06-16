/**
 * Heinz — Navigation Tests
 *
 * Covers:
 *  1. Header primary links navigate to the correct pages.
 *  2. The header nav is visible on every main page.
 *  3. Footer internal links navigate correctly from every header page.
 *  4. Footer external (KraftHeinz service) links point to correct URLs.
 *  5. Footer social media links point to correct absolute URLs.
 *  6. The brand-switcher (hamburger) overlay lists all KraftHeinz brand links
 *     with the correct absolute hrefs.
 *
 * ── Running the tests ────────────────────────────────────────────────────────
 *
 *   npm run nav:heinz             # both environments (default)
 *   npm run nav:heinz:preview     # preview (IAP-protected) only
 *   npm run nav:heinz:production  # production only
 *
 * ── Environment selection ────────────────────────────────────────────────────
 *
 *   Controlled by the TARGET_ENV env var ("preview" | "production" | "both").
 *   Base URLs are read from sites/heinz/site.config.json.
 *
 * ── Relative vs absolute links ───────────────────────────────────────────────
 *
 *   Internal links use relative hrefs (e.g. /products).  Navigation assertions
 *   check only the URL *pathname* so they pass on both preview and production
 *   regardless of the different hostnames.
 *
 *   External links (social media, KraftHeinz, brand sites) use absolute hrefs.
 *   These are verified by reading the href attribute — the tests do NOT navigate
 *   away from the Heinz domain, avoiding authentication disruption on preview
 *   and keeping tests fast.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { HeaderComponent } from './pages/header';
import { FooterComponent } from './pages/footer';
import { loginToPreview, requireAuthConfig } from '../../utils/auth';

// ── Site config & environment setup ──────────────────────────────────────────

interface SiteConfig {
  name: string;
  previewBaseUrl: string;
  productionBaseUrl: string;
}

interface Environment {
  name: string;
  baseUrl: string;      // no trailing slash
  requiresAuth: boolean;
}

/**
 * Returns the list of environments to test based on the TARGET_ENV env var.
 * Defaults to "production" when unset so CI runs without IAP credentials don't
 * break accidentally.
 */
function resolveEnvironments(): Environment[] {
  const config: SiteConfig = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'site.config.json'), 'utf8'),
  );

  const flag = (process.env.TARGET_ENV ?? 'production').toLowerCase();
  const envs: Environment[] = [];

  if (flag === 'preview' || flag === 'both') {
    envs.push({
      name: 'Preview',
      baseUrl: config.previewBaseUrl.replace(/\/$/, ''),
      requiresAuth: true,
    });
  }
  if (flag === 'production' || flag === 'both') {
    envs.push({
      name: 'Production',
      baseUrl: config.productionBaseUrl.replace(/\/$/, ''),
      requiresAuth: false,
    });
  }

  if (envs.length === 0) {
    throw new Error(
      `Unsupported TARGET_ENV "${flag}". Use "preview", "production", or "both".`,
    );
  }

  return envs;
}

const environments = resolveEnvironments();

// ── Static test data ──────────────────────────────────────────────────────────

/**
 * Pages reachable from the header nav.
 * Used as source pages for footer-link tests and header-visibility checks.
 */
const HEADER_PAGES = [
  { name: 'Home',            path: '/' },
  { name: 'Products',        path: '/products' },
  { name: 'Recipes',         path: '/recipes' },
  { name: 'Who We Are',      path: '/who-we-are' },
  { name: 'Grown Not Made',  path: '/sustainability' },
] as const;

/**
 * Relative footer links (internal navigation within the Heinz domain).
 * The href attribute is the same on both environments; only the hostname differs.
 */
const FOOTER_INTERNAL_LINKS = [
  { label: 'All Products',  href: '/products' },
  { label: 'All Recipes',   href: '/recipes' },
  { label: 'Who We Are',    href: '/who-we-are' },
  { label: 'Grown Not Made', href: '/sustainability' },
] as const;

/**
 * Absolute external links in the footer (KraftHeinz services).
 * These are environment-independent — always point to the same absolute URL.
 * Identified by aria-label in the form: "<Name> (opens in a new window)".
 */
const FOOTER_EXTERNAL_LINKS = [
  {
    label: 'Join TasteVIP (opens in a new window)',
    href:  'https://www.kraftheinz.com/tastevip',
  },
  {
    label: 'Corporate (opens in a new window)',
    href:  'https://www.kraftheinz.com/made-by-us',
  },
  {
    label: 'Contact Us (opens in a new window)',
    href:  'https://contactus.kraftheinz.com/en-us/?brand=heinz',
  },
  {
    label: 'Product Locator (opens in a new window)',
    href:  'https://www.kraftheinz.com/en-US/product-locator',
  },
] as const;

/**
 * Social media links in the footer.
 * All are absolute and open in a new window; icons have no visible text so
 * they are identified by aria-label.
 * Format: "Heinz® on <Platform> (opens in a new window)".
 */
const SOCIAL_LINKS = [
  {
    platform:  'TikTok',
    ariaLabel: 'Heinz® on Tiktok (opens in a new window)',
    href:      'https://www.tiktok.com/@heinz_us?lang=en',
  },
  {
    platform:  'Instagram',
    ariaLabel: 'Heinz® on Instagram (opens in a new window)',
    href:      'https://www.instagram.com/heinz/',
  },
  {
    platform:  'YouTube',
    ariaLabel: 'Heinz® on Youtube (opens in a new window)',
    href:      'https://www.youtube.com/HeinzKetchup',
  },
  {
    platform:  'Facebook',
    ariaLabel: 'Heinz® on Facebook (opens in a new window)',
    href:      'https://www.facebook.com/heinz',
  },
  {
    platform:  'Pinterest',
    ariaLabel: 'Heinz® on Pinterest (opens in a new window)',
    href:      'https://www.pinterest.ca/heinz',
  },
] as const;

/**
 * KraftHeinz brand links shown inside the hamburger / brand-switcher overlay.
 * All are absolute external URLs (different domains) and open in a new window.
 * Source: siteConfig.navbar.fields.universalNavigation in __NEXT_DATA__.
 */
const BRAND_LINKS = [
  { text: 'Kraft Heinz',        href: 'https://www.kraftheinz.com' },
  { text: 'Lunchables',         href: 'https://www.lunchables.com/' },
  { text: 'Velveeta',           href: 'https://www.kraftheinz.com/velveeta' },
  { text: 'Kraft Singles',      href: 'https://www.kraftheinz.com/kraft-singles' },
  { text: 'Kraft Sauces',       href: 'https://www.kraftheinz.com/kraft-sauces' },
  { text: 'Philadelphia',       href: 'https://www.kraftheinz.com/philadelphia' },
  { text: 'Kraft Mac & Cheese', href: 'https://www.kraftheinz.com/kraft-mac-and-cheese' },
  { text: 'Sure Jell',          href: 'https://www.kraftheinz.com/sure-jell' },
  { text: 'Just Crack An Egg',  href: 'https://www.kraftheinz.com/just-crack-an-egg' },
  { text: 'Ore-Ida',            href: 'https://www.kraftheinz.com/ore-ida' },
  { text: 'Delimex',            href: 'https://www.kraftheinz.com/delimex' },
  { text: 'mio',                href: 'https://www.kraftheinz.com/mio' },
  { text: 'Capri Sun',          href: 'https://www.kraftheinz.com/capri-sun' },
  { text: 'Classico',           href: 'https://www.kraftheinz.com/classico' },
  { text: 'NotCo',              href: 'http://kraftheinz.com/notco' },
  { text: "What's Cooking",     href: 'http://whatscooking.com/' },
] as const;

// ── Test suites (one per environment) ────────────────────────────────────────

for (const env of environments) {
  test.describe(`Heinz — Navigation [${env.name}]`, () => {

    // ── Shared helper ───────────────────────────────────────────────────────

    /**
     * Navigates to a page within the current environment and ensures it is
     * ready for interaction.
     *
     * For the Preview environment this calls loginToPreview(), which will
     * perform a full IAP / Firebase login on first call and return immediately
     * on subsequent calls when the session cookie is already valid.
     *
     * The OneTrust cookie-consent banner is dismissed if it appears, since it
     * can obscure nav elements and block click interactions.
     */
    async function visit(page: Parameters<typeof loginToPreview>[0], pagePath: string): Promise<void> {
      const url = `${env.baseUrl}${pagePath === '/' ? '' : pagePath}`;

      if (env.requiresAuth) {
        await loginToPreview(page, requireAuthConfig(), url);
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }

      // Dismiss OneTrust cookie banner if it is blocking the viewport.
      try {
        await page
          .locator('button:has-text("Accept All Cookies")')
          .click({ timeout: 3_000 });
      } catch {
        // Banner not present or already dismissed — safe to continue.
      }
    }

    // ── 1. Header — primary navigation links ────────────────────────────────

    test.describe('Header — primary navigation links', () => {

      test('Logo link navigates to home (/)', async ({ page }) => {
        await visit(page, '/who-we-are');
        const header = new HeaderComponent(page);
        await header.logoLink.click();
        await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe('/');
      });

      test('Products link navigates to /products', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.productsLink.click();
        await expect(page).toHaveURL(/\/products/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/products/);
      });

      test('Recipes link navigates to /recipes', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.recipesLink.click();
        await expect(page).toHaveURL(/\/recipes/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/recipes/);
      });

      test('Who We Are link navigates to /who-we-are', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.whoWeAreLink.click();
        await expect(page).toHaveURL(/\/who-we-are/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/who-we-are/);
      });

      test('Grown Not Made link navigates to /sustainability', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.sustainabilityLink.click();
        await expect(page).toHaveURL(/\/sustainability/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/sustainability/);
      });

    });

    // ── 2. Header — visible on all main pages ───────────────────────────────

    test.describe('Header — visible on all main pages', () => {
      for (const sourcePage of HEADER_PAGES) {
        test(`Nav is visible on ${sourcePage.name} (${sourcePage.path})`, async ({ page }) => {
          await visit(page, sourcePage.path);
          const header = new HeaderComponent(page);
          await header.expectNavVisible();
        });
      }
    });

    // ── 3. Footer — internal links navigate correctly ───────────────────────

    test.describe('Footer — internal links navigate correctly', () => {
      /**
       * For each starting page × each relative footer link — navigate to the
       * source, click the footer link, and verify the URL pathname matches.
       *
       * Assertions use pathname only so the same test passes against both the
       * preview hostname (heinz.prv.kraftheinz.com) and the production
       * hostname (www.heinz.com).
       */
      for (const sourcePage of HEADER_PAGES) {
        test.describe(`from ${sourcePage.name} (${sourcePage.path})`, () => {
          for (const link of FOOTER_INTERNAL_LINKS) {
            test(`Footer "${link.label}" → ${link.href}`, async ({ page }) => {
              await visit(page, sourcePage.path);
              const footer = new FooterComponent(page);

              const linkLocator = footer.internalLink(link.href);
              await linkLocator.scrollIntoViewIfNeeded();
              await linkLocator.click();

              const expectedPattern =
                link.href === '/'
                  ? /\/$/
                  : new RegExp(link.href.replace(/\//g, '\\/') + '($|\\/)');

              await expect(page).toHaveURL(expectedPattern, { timeout: 15_000 });
            });
          }
        });
      }
    });

    // ── 4. Footer — external KraftHeinz links ───────────────────────────────

    test.describe('Footer — external KraftHeinz links have correct hrefs', () => {
      /**
       * External links open in a new window — we verify the href attribute
       * instead of navigating, so we stay on the Heinz domain and avoid
       * disrupting the IAP session on preview.
       */
      test('All KraftHeinz service links point to the correct URLs', async ({ page }) => {
        await visit(page, '/');
        const footer = new FooterComponent(page);

        for (const link of FOOTER_EXTERNAL_LINKS) {
          const locator = footer.externalLink(link.label);
          await locator.scrollIntoViewIfNeeded();
          await expect(locator).toBeVisible();
          const href = await locator.getAttribute('href');
          expect(href, `Expected href for "${link.label}"`).toBe(link.href);
        }
      });
    });

    // ── 5. Footer — social media links ──────────────────────────────────────

    test.describe('Footer — social media links have correct hrefs', () => {
      /**
       * Social icons have no visible text — they are identified by aria-label.
       * We verify the href attribute (absolute URL) rather than navigating
       * to the external platform.
       */
      for (const social of SOCIAL_LINKS) {
        test(`${social.platform} link href is correct`, async ({ page }) => {
          await visit(page, '/');
          const footer = new FooterComponent(page);
          const link = footer.externalLink(social.ariaLabel);

          await link.scrollIntoViewIfNeeded();
          await expect(link).toBeVisible();
          const href = await link.getAttribute('href');
          expect(href, `Expected ${social.platform} href`).toBe(social.href);
        });
      }
    });

    // ── 6. Brand-switcher (hamburger) — brand portfolio links ───────────────

    test.describe('Brand menu (hamburger) — KraftHeinz brand links', () => {

      test('Brand menu opens and displays all KraftHeinz brand links', async ({ page }) => {
        /**
         * Opens the brand-switcher overlay and verifies that every expected
         * brand is present with its correct absolute href.
         *
         * We read the href attribute rather than clicking through to brand
         * sites to avoid leaving the Heinz domain.
         */
        await visit(page, '/');
        const header = new HeaderComponent(page);

        await header.openBrandMenu();

        const actualLinks = await header.getBrandLinks();
        const actualByHref = new Map(actualLinks.map((l) => [l.href, l.text]));

        for (const expected of BRAND_LINKS) {
          expect(
            actualByHref.has(expected.href),
            `Brand link missing: ${expected.text} (${expected.href})`,
          ).toBe(true);

          const actualText = actualByHref.get(expected.href)!;
          expect(actualText, `Brand name mismatch for ${expected.href}`).toBe(expected.text);
        }
      });

      test('All brand links point to absolute external URLs', async ({ page }) => {
        /**
         * Secondary guard: ensures no brand link accidentally uses a relative
         * path (which would be broken if served from the wrong domain).
         */
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.openBrandMenu();

        const links = await header.getBrandLinks();
        for (const link of links) {
          expect(
            link.href.startsWith('http'),
            `Brand link "${link.text}" href "${link.href}" is not absolute`,
          ).toBe(true);
        }
      });

    });

  });
}
