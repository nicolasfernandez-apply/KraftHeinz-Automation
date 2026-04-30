import { Page, Locator } from '@playwright/test';

/**
 * Page Object for the Oscar Mayer site footer.
 *
 * The footer (<footer> element) contains three categories of links:
 *
 *  1. Internal links — relative hrefs that stay within the Oscar Mayer domain.
 *     These differ between environments (preview vs production base URL).
 *
 *  2. External KraftHeinz links — absolute URLs to kraftheinz.com services
 *     (Product Locator, TasteVIP, Contact Us, Corporate, legal pages).
 *     These are the same in all environments and open in a new window.
 *
 *  3. Social media links — absolute URLs to social platforms.
 *     Identified via aria-label since the icons have no visible text.
 *     Format: "<Platform> (opens in a new window)".
 */
export class FooterComponent {
  readonly page: Page;

  /** Root footer element. All locators are scoped to it. */
  readonly footer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.footer = page.locator('footer').first();
  }

  // ── Internal link helpers ─────────────────────────────────────────────────

  /**
   * Returns a locator for an internal footer link by its relative href.
   *
   * Example: `footer.internalLink('/products')`.
   *
   * Scoped to the footer so that header links with identical hrefs (e.g.
   * <a href="/products">) are not matched by mistake.
   */
  internalLink(path: string): Locator {
    return this.footer.locator(`a[href="${path}"]`).first();
  }

  // ── External link helpers ─────────────────────────────────────────────────

  /**
   * Returns a locator for an external footer link by its aria-label.
   *
   * All external links (KraftHeinz services, social, legal) carry an
   * aria-label in the form: "<Name> (opens in a new window)".
   *
   * Example: `footer.externalLink('TikTok (opens in a new window)')`.
   */
  externalLink(ariaLabel: string): Locator {
    return this.footer.locator(`a[aria-label="${ariaLabel}"]`);
  }

  // ── Convenience getters for social media links ────────────────────────────

  /**
   * Named accessors for the four social media links.
   * Uses the aria-label pattern "<Platform> (opens in a new window)".
   */
  get socialLinks(): Record<'tiktok' | 'instagram' | 'facebook' | 'youtube', Locator> {
    return {
      tiktok:    this.externalLink('TikTok (opens in a new window)'),
      instagram: this.externalLink('Instagram (opens in a new window)'),
      facebook:  this.externalLink('Facebook (opens in a new window)'),
      // Note: the aria-label uses "Youtube" (lowercase u), not "YouTube"
      youtube:   this.externalLink('Youtube (opens in a new window)'),
    };
  }
}
