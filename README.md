# KraftHeinz URL Comparison Tool

Playwright-based automation that compares a **Preview** URL against a **Production** URL and generates a self-contained HTML report with a side-by-side diff, plus an [Allure](https://allurereport.org/) report with run history.

## What it compares

| Category | Details |
|---|---|
| **Screenshots** | Full-page screenshots of both URLs, side by side |
| **Page Metadata** | Title, meta description, canonical, OG tags, robots, language, viewport |
| **HTTP Status** | Status codes and final URLs after redirects (host excluded) |
| **Page Structure** | Headings, images, links, forms, scripts, stylesheets, video counts |
| **Heading Structure** | Full H1–H6 tree with highlights for headings that only exist on one side |
| **Content Comparison** | Text blocks, image paths, link paths, and video paths unique to each environment |
| **Videos** | Native CDN-hosted `<video>` elements compared by path (CDN host excluded) |
| **Accessibility** | axe-core violations with affected elements, selector, HTML snippet, and failure reason |
| **Performance Metrics** | Load time, DOMContentLoaded, FCP, response end, transfer size |
| **Console Messages** | Errors and warnings captured from both pages |

---

## Modes

There are two ways to run comparisons:

| Mode | Best for |
|---|---|
| **Ad-hoc** (`urls.config.json`) | Comparing a specific list of URLs across any brand |
| **Site crawl** (`sites/<brand>/`) | Comparing an entire brand site discovered via its sitemap |

---

## Option A — Run from GitHub Actions

This is the recommended way to run comparisons. No local setup required.

1. Go to the repository on GitHub → **Actions** → **URL Comparison — Preview vs Production**
2. Click **Run workflow**
3. In the **URL pairs** field, paste a JSON object with the pages to compare:

```json
{
  "comparisons": [
    {
      "name": "Home Page",
      "previewUrl": "https://heinz.prv.kraftheinz.com/en-CA/rules",
      "productionUrl": "https://www.heinz.com/en-CA/rules"
    },
    {
      "name": "Another Page",
      "previewUrl": "https://heinz.prv.kraftheinz.com/en-CA/other",
      "productionUrl": "https://www.heinz.com/en-CA/other"
    }
  ]
}
```

Leave the field **empty** to use the URL pairs already saved in `urls.config.json`.

4. Click **Run workflow**

Once the run completes:
- **Comparison reports** and the **Allure report** are available as downloadable artifacts on the run page
- The **Allure history dashboard** (with links to every run's report) is published to GitHub Pages

> **Prerequisites:** `PREVIEW_USERNAME` and `PREVIEW_PASSWORD` must be added as repository secrets under **Settings → Secrets and variables → Actions**.

---

## Option B — Run locally from the command line

### 1. Install dependencies

```bash
npm install
npm run install:browsers
```

### 2. Configure credentials

Copy the example env file and fill in your Preview environment credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PREVIEW_USERNAME=your-email@example.com
PREVIEW_PASSWORD=your-password
```

### 3. Configure URLs

Edit `urls.config.json` with the pages you want to compare:

```json
{
  "comparisons": [
    {
      "name": "Rules Page - Canada",
      "previewUrl": "https://heinz.prv.kraftheinz.com/en-CA/rules",
      "productionUrl": "https://www.heinz.com/en-CA/rules"
    }
  ]
}
```

You can add as many entries to the `comparisons` array as needed — one report is generated per pair.

### 4. Run the comparison

```bash
npm run compare
```

Reports are saved to `reports/` — open any `.html` file in a browser. Each report is fully self-contained (screenshots embedded as base64).

```bash
# Run with a visible browser window (useful for debugging login issues)
npm run compare:headed
```

---

## Site comparisons

Brand-specific comparisons live under `sites/<brand>/`. Each site discovers its own pages via the production sitemap before running the comparison.

### Oscar Mayer

**Configuration:** [`sites/oscar-mayer/site.config.json`](sites/oscar-mayer/site.config.json)

```json
{
  "previewBaseUrl": "https://oscarmayer.prv.kraftheinz.com/",
  "productionBaseUrl": "https://www.oscarmayer.com/",
  "sitemapPath": "/sitemap.xml",
  "excludePatterns": [],
  "maxPages": 0
}
```

- `excludePatterns` — array of regex strings for paths to skip (e.g. `["/recipes/.*"]`)
- `maxPages` — cap the number of pages compared per run (`0` = unlimited)

**Running:**

```bash
# Step 1 — discover pages from the production sitemap → writes sites/oscar-mayer/pages.json
npm run crawl:oscar-mayer

# Step 2 — run the comparison for every discovered page
npm run compare:oscar-mayer

# Or do both in one command
npm run site:oscar-mayer
```

Reports are saved to `sites/oscar-mayer/reports/` — one HTML file per page.

**Tip:** After crawling, you can open `sites/oscar-mayer/pages.json` and manually remove entries before running the comparison. The crawl step does not need to be repeated unless the site structure changes.

---

## Adding a new brand site

1. Create a folder `sites/<brand-slug>/`
2. Copy `sites/oscar-mayer/site.config.json` and update the URLs
3. Copy `sites/oscar-mayer/crawler.mjs` — no changes needed
4. Copy `sites/oscar-mayer/compare.spec.ts` and update the three hardcoded references to `oscar-mayer` and the `test.describe` label
5. Add three scripts to `package.json`:

```json
"crawl:<brand>": "node sites/<brand>/crawler.mjs",
"compare:<brand>": "playwright test sites/<brand>/compare.spec.ts",
"site:<brand>": "npm run crawl:<brand> && npm run compare:<brand>"
```

---

## Test failure tags

Tests are automatically marked as **failed** and tagged when specific conditions are detected. Tags appear as filter chips in the Playwright HTML report.

| Tag | Condition |
|---|---|
| `difference-in-content` | Image count, alt text, image paths, text blocks, links, or videos differ between environments |
| `only-in-preview` | Page loads on Preview but returns an error or 4xx on Production |
| `only-in-production` | Page loads on Production but returns an error or 4xx on Preview |

To filter by tag in the Playwright HTML report, type the tag name in the search bar or click its chip in the filter bar. To re-run only tagged tests from the CLI:

```bash
npx playwright test --grep "difference-in-content"
npx playwright test --grep "only-in-preview|only-in-production"
```

---

## Report structure

Each HTML report includes:

- **Summary cards** — total differences, critical differences, console issues per side, accessibility violations
- **Screenshots** — full-page captures side by side
- **Collapsible sections** — click any section header to expand/collapse
- **Color coding** — red rows = difference, green checkmarks = match
- **Content diff tables** — text blocks, images, links, and videos unique to Preview or Production
- **Accessibility section** — axe-core violations grouped by impact, with affected DOM elements shown
- **Performance bars** — visual bars with delta % highlighted if >20% difference
- **Heading tree** — unique headings (only on one side) highlighted in red
