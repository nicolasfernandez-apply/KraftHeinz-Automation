import { Page, Locator } from '@playwright/test';

/**
 * Page Object for the Heinz site footer.
 *
 * The footer (<footer> element) contains four categories of links:
 *
 *  1. Internal links — relative hrefs that stay within the Heinz domain.
 *     Identified by data-testid="footer-link" and a relative href.
 *
 *  2. External KraftHeinz links — absolute URLs to kraftheinz.com services
 *     (TasteVIP, Corporate, Contact Us, Product Locator).
 *     These carry an aria-label in the form: "<Name> (opens in a new window)".
 *
 *  3. Social media links — absolute URLs to social platforms.
 *     Identified via aria-label (icons have no visible text).
 *     Format: "Heinz® on <Platform> (opens in a new window)".
 *
 *  4. Legal links — internal relative hrefs (/privacy-policy, /terms-of-use, etc.).
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
   * Scoped to the footer so that header links with identical hrefs are not
   * matched by mistake.
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
   * Example: `footer.externalLink('Contact Us (opens in a new window)')`.
   */
  externalLink(ariaLabel: string): Locator {
    return this.footer.locator(`a[aria-label="${ariaLabel}"]`);
  }

  // ── Convenience getters for social media links ────────────────────────────

  /**
   * Named accessors for the five social media links.
   * Uses the aria-label pattern "Heinz® on <Platform> (opens in a new window)".
   */
  get socialLinks(): Record<'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'pinterest', Locator> {
    return {
      tiktok:    this.externalLink('Heinz® on Tiktok (opens in a new window)'),
      instagram: this.externalLink('Heinz® on Instagram (opens in a new window)'),
      youtube:   this.externalLink('Heinz® on Youtube (opens in a new window)'),
      facebook:  this.externalLink('Heinz® on Facebook (opens in a new window)'),
      pinterest: this.externalLink('Heinz® on Pinterest (opens in a new window)'),
    };
  }
}
