/**
 * Oscar Mayer — Navigation Tests
 *
 * Covers:
 *  1. Header primary links navigate to the correct pages.
 *  2. The header nav is visible on every main page.
 *  3. Footer internal links navigate correctly from every header page.
 *  4. Footer external (KraftHeinz service + legal) links point to correct URLs.
 *  5. Footer social media links point to correct absolute URLs.
 *  6. The brand-switcher (hamburger) overlay lists all KraftHeinz brand links
 *     with the correct absolute hrefs.
 *
 * ── Running the tests ────────────────────────────────────────────────────────
 *
 *   npm run nav:oscar-mayer             # both environments (default)
 *   npm run nav:oscar-mayer:preview     # preview (IAP-protected) only
 *   npm run nav:oscar-mayer:production  # production only
 *
 * ── Environment selection ────────────────────────────────────────────────────
 *
 *   Controlled by the TARGET_ENV env var ("preview" | "production" | "both").
 *   Base URLs are read from sites/oscar-mayer/site.config.json.
 *
 * ── Relative vs absolute links ───────────────────────────────────────────────
 *
 *   Internal links use relative hrefs (e.g. /products).  Navigation assertions
 *   check only the URL *pathname* so they pass on both preview and production
 *   regardless of the different hostnames.
 *
 *   External links (social media, KraftHeinz, brand sites) use absolute hrefs.
 *   These are verified by reading the href attribute — the tests do NOT navigate
 *   away from the Oscar Mayer domain, avoiding authentication disruption on
 *   preview and keeping tests fast.
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
  { name: 'Home',         path: '/' },
  { name: 'Products',     path: '/products' },
  { name: 'Wienermobile', path: '/wienermobile' },
  { name: 'Our Story',    path: '/our-story' },
] as const;

/**
 * Relative footer links (internal navigation within the Oscar Mayer domain).
 * The href attribute is the same on both environments; only the hostname differs.
 */
const FOOTER_INTERNAL_LINKS = [
  { label: 'Home',         href: '/' },
  { label: 'Our Story',    href: '/our-story' },
  { label: 'Our Products', href: '/products' },
  { label: 'Wienermobile', href: '/wienermobile' },
  { label: 'Hotdoggers',   href: '/hotdoggers' },
] as const;

/**
 * Absolute external links in the footer (KraftHeinz services and legal).
 * These are environment-independent — always point to the same absolute URL.
 */
const FOOTER_EXTERNAL_LINKS = [
  {
    label: 'Product Locator (opens in a new window)',
    href:  'https://www.kraftheinz.com/en-US/product-locator',
  },
  {
    label: 'Join TasteVIP (opens in a new window)',
    href:  'https://www.kraftheinz.com/tastevip',
  },
  {
    label: 'Contact Us (opens in a new window)',
    href:  'https://contactus.kraftheinz.com/en-us/?brand=oscarmayer',
  },
  {
    label: 'Corporate (opens in a new window)',
    href:  'https://www.kraftheinz.com/made-by-us',
  },
  {
    label: 'Terms and Conditions (opens in a new window)',
    href:  'https://www.kraftheinz.com/terms-of-use',
  },
  {
    label: 'Privacy Notice (opens in a new window)',
    href:  'https://www.kraftheinz.com/privacy-policy',
  },
] as const;

/**
 * Social media links in the footer.
 * All are absolute and open in a new window; icons have no visible text so
 * they are identified by aria-label.
 */
const SOCIAL_LINKS = [
  {
    platform:  'TikTok',
    ariaLabel: 'TikTok (opens in a new window)',
    href:      'https://www.tiktok.com/@oscarmayer?lang=en',
  },
  {
    platform:  'Instagram',
    ariaLabel: 'Instagram (opens in a new window)',
    href:      'https://www.instagram.com/oscarmayer/?hl=en',
  },
  {
    platform:  'Facebook',
    ariaLabel: 'Facebook (opens in a new window)',
    href:      'https://www.facebook.com/OscarMayer/',
  },
  {
    // Note: the site uses "Youtube" (lowercase u) in the aria-label
    platform:  'YouTube',
    ariaLabel: 'Youtube (opens in a new window)',
    href:      'https://www.youtube.com/user/oscarmayer',
  },
] as const;

/**
 * KraftHeinz brand links shown inside the hamburger / brand-switcher overlay.
 * All are absolute external URLs (different domains) and open in a new window.
 */
const BRAND_LINKS = [
  { text: 'Heinz',              href: 'https://www.heinz.com/' },
  { text: 'Lunchables',         href: 'https://www.lunchables.com/' },
  { text: 'Kraft Mac & Cheese', href: 'https://www.kraftheinz.com/kraft-mac-and-cheese' },
  { text: 'Kraft Singles',      href: 'https://www.kraftheinz.com/kraft-singles' },
  { text: 'Velveeta',           href: 'https://www.kraftheinz.com/velveeta' },
  { text: 'Taco Bell',          href: 'https://www.kraftheinz.com/taco-bell' },
  { text: 'Sure Jell',          href: 'https://www.kraftheinz.com/sure-jell' },
  { text: 'Jet-Puffed',         href: 'https://www.kraftheinz.com/jetpuffed' },
  { text: 'JELL-O',             href: 'https://www.kraftheinz.com/jell-o' },
  { text: 'Claussen',           href: 'https://www.kraftheinz.com/claussen' },
  { text: "What's Cooking",     href: 'http://whatscooking.com/' },
] as const;

// ── Test suites (one per environment) ────────────────────────────────────────

for (const env of environments) {
  test.describe(`Oscar Mayer — Navigation [${env.name}]`, () => {

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
        // loginToPreview navigates to the URL internally and handles IAP auth.
        // The global-setup.ts writes .auth/<hostname>.json before any test runs,
        // so this will almost always hit the early-return "session already valid" path.
        await loginToPreview(page, requireAuthConfig(), url);
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }

      // Dismiss OneTrust cookie banner if it is blocking the viewport.
      // Using a short timeout so the helper does not slow down tests on pages
      // where the banner has already been accepted.
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
        // Start on a non-home page to make the navigation meaningful
        await visit(page, '/our-story');
        const header = new HeaderComponent(page);
        await header.logoLink.click();
        // Only check the pathname — the hostname differs between environments
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

      test('Wienermobile® link navigates to /wienermobile', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.wienermobileLink.click();
        await expect(page).toHaveURL(/\/wienermobile/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/wienermobile/);
      });

      test('Our Story link navigates to /our-story', async ({ page }) => {
        await visit(page, '/');
        const header = new HeaderComponent(page);
        await header.ourStoryLink.click();
        await expect(page).toHaveURL(/\/our-story/, { timeout: 15_000 });
        expect(new URL(page.url()).pathname).toMatch(/^\/our-story/);
      });

    });

    // ── 2. Header — visible on all main pages ───────────────────────────────

    test.describe('Header — visible on all main pages', () => {
      // Ensures the navigation component is rendered after navigating to each
      // of the primary pages (not just the home page).
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
       * For each starting page (home + all header-nav pages) × each relative
       * footer link — navigate to the source, click the footer link, and verify
       * the URL pathname matches.
       *
       * Assertions use pathname only so the same test passes against both the
       * preview hostname (oscarmayer.prv.kraftheinz.com) and the production
       * hostname (www.oscarmayer.com).
       */
      for (const sourcePage of HEADER_PAGES) {
        test.describe(`from ${sourcePage.name} (${sourcePage.path})`, () => {
          for (const link of FOOTER_INTERNAL_LINKS) {
            test(`Footer "${link.label}" → ${link.href}`, async ({ page }) => {
              await visit(page, sourcePage.path);
              const footer = new FooterComponent(page);

              // Scroll the link into view before clicking — the footer may be
              // below the fold on shorter viewports and some links could be
              // obscured by sticky elements if not scrolled to first.
              const linkLocator = footer.internalLink(link.href);
              await linkLocator.scrollIntoViewIfNeeded();
              await linkLocator.click();

              // toHaveURL matches against the *full* URL (including scheme + hostname),
              // so patterns must NOT be anchored with ^\.
              //
              // Home (/): the URL is https://www.oscarmayer.com/ — use a trailing-
              //   slash anchor (\/$) which matches the root path but not /products/.
              //
              // Other paths (/products etc.): match the path segment followed by end-
              //   of-string or a slash, so /\/products($|\/) matches
              //   https://www.oscarmayer.com/products and .../products/ but NOT
              //   .../products-list (accidental partial match).
              //
              // toHaveURL retries until the condition is met (or timeout), making it
              // robust against navigation latency — unlike a one-shot page.url() check.
              const expectedPattern =
                link.href === '/'
                  ? /\/$/ // URL ends with / — matches the root, not /products/
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
       * instead of navigating, so we stay on the Oscar Mayer domain and
       * avoid disrupting the IAP session on preview.
       */
      test('All KraftHeinz service and legal links point to the correct URLs', async ({ page }) => {
        await visit(page, '/');
        const footer = new FooterComponent(page);

        for (const link of FOOTER_EXTERNAL_LINKS) {
          const locator = footer.externalLink(link.label);
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
         * sites to avoid leaving the Oscar Mayer domain.
         */
        await visit(page, '/');
        const header = new HeaderComponent(page);

        await header.openBrandMenu();

        // Retrieve the complete set of brand links from the overlay
        const actualLinks = await header.getBrandLinks();
        const actualByHref = new Map(actualLinks.map((l) => [l.href, l.text]));

        for (const expected of BRAND_LINKS) {
          expect(
            actualByHref.has(expected.href),
            `Brand link missing: ${expected.text} (${expected.href})`,
          ).toBe(true);

          // Verify the visible brand name matches (first line of innerText)
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
