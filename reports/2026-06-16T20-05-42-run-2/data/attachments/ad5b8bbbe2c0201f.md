# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sites/heinz/navigation.spec.ts >> Heinz — Navigation [Preview] >> Footer — social media links have correct hrefs >> Pinterest link href is correct
- Location: sites/heinz/navigation.spec.ts:364:13

# Error details

```
Error: locator.scrollIntoViewIfNeeded: Element is not attached to the DOM
Call log:
  - attempting scroll into view action
    - waiting for element to be stable

```

# Test source

```ts
  269 |       test('Who We Are link navigates to /who-we-are', async ({ page }) => {
  270 |         await visit(page, '/');
  271 |         const header = new HeaderComponent(page);
  272 |         await header.whoWeAreLink.click();
  273 |         await expect(page).toHaveURL(/\/who-we-are/, { timeout: 15_000 });
  274 |         expect(new URL(page.url()).pathname).toMatch(/^\/who-we-are/);
  275 |       });
  276 | 
  277 |       test('Grown Not Made link navigates to /sustainability', async ({ page }) => {
  278 |         await visit(page, '/');
  279 |         const header = new HeaderComponent(page);
  280 |         await header.sustainabilityLink.click();
  281 |         await expect(page).toHaveURL(/\/sustainability/, { timeout: 15_000 });
  282 |         expect(new URL(page.url()).pathname).toMatch(/^\/sustainability/);
  283 |       });
  284 | 
  285 |     });
  286 | 
  287 |     // ── 2. Header — visible on all main pages ───────────────────────────────
  288 | 
  289 |     test.describe('Header — visible on all main pages', () => {
  290 |       for (const sourcePage of HEADER_PAGES) {
  291 |         test(`Nav is visible on ${sourcePage.name} (${sourcePage.path})`, async ({ page }) => {
  292 |           await visit(page, sourcePage.path);
  293 |           const header = new HeaderComponent(page);
  294 |           await header.expectNavVisible();
  295 |         });
  296 |       }
  297 |     });
  298 | 
  299 |     // ── 3. Footer — internal links navigate correctly ───────────────────────
  300 | 
  301 |     test.describe('Footer — internal links navigate correctly', () => {
  302 |       /**
  303 |        * For each starting page × each relative footer link — navigate to the
  304 |        * source, click the footer link, and verify the URL pathname matches.
  305 |        *
  306 |        * Assertions use pathname only so the same test passes against both the
  307 |        * preview hostname (heinz.prv.kraftheinz.com) and the production
  308 |        * hostname (www.heinz.com).
  309 |        */
  310 |       for (const sourcePage of HEADER_PAGES) {
  311 |         test.describe(`from ${sourcePage.name} (${sourcePage.path})`, () => {
  312 |           for (const link of FOOTER_INTERNAL_LINKS) {
  313 |             test(`Footer "${link.label}" → ${link.href}`, async ({ page }) => {
  314 |               await visit(page, sourcePage.path);
  315 |               const footer = new FooterComponent(page);
  316 | 
  317 |               const linkLocator = footer.internalLink(link.href);
  318 |               await linkLocator.scrollIntoViewIfNeeded();
  319 |               await linkLocator.click();
  320 | 
  321 |               const expectedPattern =
  322 |                 link.href === '/'
  323 |                   ? /\/$/
  324 |                   : new RegExp(link.href.replace(/\//g, '\\/') + '($|\\/)');
  325 | 
  326 |               await expect(page).toHaveURL(expectedPattern, { timeout: 15_000 });
  327 |             });
  328 |           }
  329 |         });
  330 |       }
  331 |     });
  332 | 
  333 |     // ── 4. Footer — external KraftHeinz links ───────────────────────────────
  334 | 
  335 |     test.describe('Footer — external KraftHeinz links have correct hrefs', () => {
  336 |       /**
  337 |        * External links open in a new window — we verify the href attribute
  338 |        * instead of navigating, so we stay on the Heinz domain and avoid
  339 |        * disrupting the IAP session on preview.
  340 |        */
  341 |       test('All KraftHeinz service links point to the correct URLs', async ({ page }) => {
  342 |         await visit(page, '/');
  343 |         const footer = new FooterComponent(page);
  344 | 
  345 |         for (const link of FOOTER_EXTERNAL_LINKS) {
  346 |           const locator = footer.externalLink(link.label);
  347 |           await locator.scrollIntoViewIfNeeded();
  348 |           await expect(locator).toBeVisible();
  349 |           const href = await locator.getAttribute('href');
  350 |           expect(href, `Expected href for "${link.label}"`).toBe(link.href);
  351 |         }
  352 |       });
  353 |     });
  354 | 
  355 |     // ── 5. Footer — social media links ──────────────────────────────────────
  356 | 
  357 |     test.describe('Footer — social media links have correct hrefs', () => {
  358 |       /**
  359 |        * Social icons have no visible text — they are identified by aria-label.
  360 |        * We verify the href attribute (absolute URL) rather than navigating
  361 |        * to the external platform.
  362 |        */
  363 |       for (const social of SOCIAL_LINKS) {
  364 |         test(`${social.platform} link href is correct`, async ({ page }) => {
  365 |           await visit(page, '/');
  366 |           const footer = new FooterComponent(page);
  367 |           const link = footer.externalLink(social.ariaLabel);
  368 | 
> 369 |           await link.scrollIntoViewIfNeeded();
      |                      ^ Error: locator.scrollIntoViewIfNeeded: Element is not attached to the DOM
  370 |           await expect(link).toBeVisible();
  371 |           const href = await link.getAttribute('href');
  372 |           expect(href, `Expected ${social.platform} href`).toBe(social.href);
  373 |         });
  374 |       }
  375 |     });
  376 | 
  377 |     // ── 6. Brand-switcher (hamburger) — brand portfolio links ───────────────
  378 | 
  379 |     test.describe('Brand menu (hamburger) — KraftHeinz brand links', () => {
  380 | 
  381 |       test('Brand menu opens and displays all KraftHeinz brand links', async ({ page }) => {
  382 |         /**
  383 |          * Opens the brand-switcher overlay and verifies that every expected
  384 |          * brand is present with its correct absolute href.
  385 |          *
  386 |          * We read the href attribute rather than clicking through to brand
  387 |          * sites to avoid leaving the Heinz domain.
  388 |          */
  389 |         await visit(page, '/');
  390 |         const header = new HeaderComponent(page);
  391 | 
  392 |         await header.openBrandMenu();
  393 | 
  394 |         const actualLinks = await header.getBrandLinks();
  395 |         const actualByHref = new Map(actualLinks.map((l) => [l.href, l.text]));
  396 | 
  397 |         for (const expected of BRAND_LINKS) {
  398 |           expect(
  399 |             actualByHref.has(expected.href),
  400 |             `Brand link missing: ${expected.text} (${expected.href})`,
  401 |           ).toBe(true);
  402 | 
  403 |           const actualText = actualByHref.get(expected.href)!;
  404 |           expect(actualText, `Brand name mismatch for ${expected.href}`).toBe(expected.text);
  405 |         }
  406 |       });
  407 | 
  408 |       test('All brand links point to absolute external URLs', async ({ page }) => {
  409 |         /**
  410 |          * Secondary guard: ensures no brand link accidentally uses a relative
  411 |          * path (which would be broken if served from the wrong domain).
  412 |          */
  413 |         await visit(page, '/');
  414 |         const header = new HeaderComponent(page);
  415 |         await header.openBrandMenu();
  416 | 
  417 |         const links = await header.getBrandLinks();
  418 |         for (const link of links) {
  419 |           expect(
  420 |             link.href.startsWith('http'),
  421 |             `Brand link "${link.text}" href "${link.href}" is not absolute`,
  422 |           ).toBe(true);
  423 |         }
  424 |       });
  425 | 
  426 |     });
  427 | 
  428 |   });
  429 | }
  430 | 
```