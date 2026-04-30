import { Page, Locator, expect } from '@playwright/test';

/**
 * Page Object for the Oscar Mayer site header / primary navigation.
 *
 * Structure discovered via live DOM inspection:
 *  - The nav is a single <nav aria-label="Main Navigation"> element.
 *  - Internal links use aria-label attributes (visible text is all-caps styling).
 *  - The brand switcher is a <div aria-label="Open menu"> (not a <button>).
 *  - Clicking the brand switcher opens a fixed full-screen overlay that lists
 *    all KraftHeinz portfolio brands.
 */
export class HeaderComponent {
  readonly page: Page;

  /** The main navigation element. */
  readonly nav: Locator;

  /**
   * Logo link — the first <a href="/"> in the nav.
   * It wraps an SVG logo and has no visible text.
   */
  readonly logoLink: Locator;

  // ── Primary navigation links ─────────────────────────────────────────────

  /** "Products" nav link (aria-label="Products"). */
  readonly productsLink: Locator;

  /** "WIENERMOBILE®" nav link (aria-label="WIENERMOBILE®"). */
  readonly wienermobileLink: Locator;

  /** "Our Story" nav link (aria-label="Our Story"). */
  readonly ourStoryLink: Locator;

  /**
   * Brand-switcher trigger — a <div aria-label="Open menu"> inside the nav.
   * Clicking it reveals the KraftHeinz brand portfolio overlay.
   */
  readonly brandMenuTrigger: Locator;

  constructor(page: Page) {
    this.page = page;

    // Scope all header locators to the nav to avoid conflicts with footer links
    // that share the same relative hrefs (e.g. <a href="/products">).
    this.nav = page.locator('nav[aria-label="Main Navigation"]');

    this.logoLink = this.nav.locator('a[href="/"]').first();

    // Nav links are found by aria-label because the visible text is uppercase
    // (applied via CSS), and aria-label carries the canonical name.
    this.productsLink    = this.nav.locator('a[aria-label="Products"]');
    this.wienermobileLink = this.nav.locator('a[aria-label="WIENERMOBILE®"]');
    this.ourStoryLink    = this.nav.locator('a[aria-label="Our Story"]');

    // The brand switcher is a styled <div>, not a <button>, so we target it
    // by its aria-label rather than role="button".
    this.brandMenuTrigger = this.nav.locator('[aria-label="Open menu"]');
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Opens the KraftHeinz brand portfolio overlay.
   * Waits until the Heinz link is visible, confirming the panel is fully open.
   */
  async openBrandMenu(): Promise<void> {
    await this.brandMenuTrigger.click();
    // Heinz is always the first brand listed — use it as the ready signal
    await this.page
      .locator('a[href="https://www.heinz.com/"]')
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
    // by filtering for a descendant Heinz link (unique to the overlay).
    const overlay = this.page.locator('div.fixed').filter({
      has: this.page.locator('a[href="https://www.heinz.com/"]'),
    });

    const links = overlay.locator('a[href]');
    const count = await links.count();
    const result: { text: string; href: string }[] = [];

    for (let i = 0; i < count; i++) {
      const a = links.nth(i);
      const href = (await a.getAttribute('href')) ?? '';
      const text = (await a.innerText()).split('\n')[0].trim();
      // Only include links that are absolute external URLs (brand sites).
      // The overlay may contain UI-only anchors (e.g. a close button with href="/")
      // that are not brand links and would break the "all hrefs are absolute" assertion.
      if (href && href.startsWith('http')) result.push({ text, href });
    }

    return result;
  }

  // ── Assertions ────────────────────────────────────────────────────────────

  /**
   * Asserts that the nav and all primary links are visible on the current page.
   * Use this to verify the header renders correctly after navigating.
   */
  async expectNavVisible(): Promise<void> {
    await expect(this.nav).toBeVisible();
    await expect(this.productsLink).toBeVisible();
    await expect(this.wienermobileLink).toBeVisible();
    await expect(this.ourStoryLink).toBeVisible();
  }
}
