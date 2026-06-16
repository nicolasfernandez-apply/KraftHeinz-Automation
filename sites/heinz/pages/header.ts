import { Page, Locator, expect } from '@playwright/test';

/**
 * Page Object for the Heinz site header / primary navigation.
 *
 * Structure discovered via live DOM inspection:
 *  - The nav is a single <nav aria-label="Main Navigation"> element.
 *  - The logo link is identified by data-testid="logo-anchor".
 *  - Primary nav links are <a> tags with their path as the href attribute.
 *    They carry no aria-label (unlike Oscar Mayer); href selectors are used.
 *  - The brand switcher is a <div aria-label="Open menu" data-testid="open-universal-nav-btn">.
 *  - Clicking the brand switcher opens a fixed full-screen overlay listing
 *    the KraftHeinz portfolio brands.
 */
export class HeaderComponent {
  readonly page: Page;

  /** The main navigation element. */
  readonly nav: Locator;

  /**
   * Logo link — <a data-testid="logo-anchor" href="/">.
   * Wraps an SVG logo (aria-label="Heinz® Sauces and Condiments") with no visible text.
   */
  readonly logoLink: Locator;

  // ── Primary navigation links ─────────────────────────────────────────────

  /** "Products" nav link (<a href="/products">). */
  readonly productsLink: Locator;

  /** "Recipes" nav link (<a href="/recipes">). */
  readonly recipesLink: Locator;

  /** "Who We Are" nav link (<a href="/who-we-are">). */
  readonly whoWeAreLink: Locator;

  /** "Grown Not Made" / Sustainability nav link (<a href="/sustainability">). */
  readonly sustainabilityLink: Locator;

  /**
   * Brand-switcher trigger — <div aria-label="Open menu"> inside the nav.
   * Clicking it reveals the KraftHeinz brand portfolio overlay.
   */
  readonly brandMenuTrigger: Locator;

  constructor(page: Page) {
    this.page = page;

    this.nav = page.locator('nav[aria-label="Main Navigation"]');

    this.logoLink = this.nav.locator('a[data-testid="logo-anchor"]');

    // Nav links have no aria-label; use href selectors scoped to the nav.
    // .first() prefers the desktop version, which appears before the mobile
    // mega-menu container in the DOM.
    this.productsLink    = this.nav.locator('a[href="/products"]').first();
    this.recipesLink     = this.nav.locator('a[href="/recipes"]').first();
    this.whoWeAreLink    = this.nav.locator('a[href="/who-we-are"]').first();
    this.sustainabilityLink = this.nav.locator('a[href="/sustainability"]').first();

    this.brandMenuTrigger = this.nav.locator('[aria-label="Open menu"]');
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Opens the KraftHeinz brand portfolio overlay.
   * Waits until the Kraft Heinz link is visible, confirming the panel is fully open.
   */
  async openBrandMenu(): Promise<void> {
    await this.brandMenuTrigger.click();
    await this.page
      .locator('a[href="https://www.kraftheinz.com"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
  }

  /**
   * Returns all brand links visible in the open overlay as {text, href} pairs.
   * Call openBrandMenu() before this.
   *
   * Note: innerText may include "(opens in a new window)" on a second line
   * (injected by an accessibility helper); only the first line is returned.
   */
  async getBrandLinks(): Promise<{ text: string; href: string }[]> {
    // The overlay is a fixed full-screen <div>; scope to links inside it
    // by filtering for the Kraft Heinz link (unique to the overlay).
    const overlay = this.page.locator('div.fixed').filter({
      has: this.page.locator('a[href="https://www.kraftheinz.com"]'),
    });

    const links = overlay.locator('a[href]');
    const count = await links.count();
    const result: { text: string; href: string }[] = [];

    for (let i = 0; i < count; i++) {
      const a = links.nth(i);
      const href = (await a.getAttribute('href')) ?? '';
      const text = (await a.innerText()).split('\n')[0].trim();
      // Only include absolute external URLs — skip UI-only anchors (e.g. close button).
      if (href && href.startsWith('http')) result.push({ text, href });
    }

    return result;
  }

  // ── Assertions ────────────────────────────────────────────────────────────

  /**
   * Asserts that the nav and all primary links are visible on the current page.
   */
  async expectNavVisible(): Promise<void> {
    await expect(this.nav).toBeVisible();
    await expect(this.productsLink).toBeVisible();
    await expect(this.recipesLink).toBeVisible();
    await expect(this.whoWeAreLink).toBeVisible();
  }
}
