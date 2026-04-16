# KraftHeinz URL Comparison Tool

Playwright-based automation that compares a **Preview** URL against a **Production** URL and generates a self-contained HTML report with a side-by-side diff, plus an [Allure](https://allurereport.org/) report with run history.

## What it compares

| Category | Details |
|---|---|
| **Screenshots** | Full-page screenshots of both URLs, side by side |
| **Page Metadata** | Title, meta description, canonical, OG tags, robots, language, viewport |
| **HTTP Status** | Status codes and final URLs after redirects (host excluded) |
| **Page Structure** | Headings, images, links, forms, scripts, stylesheets counts |
| **Heading Structure** | Full H1–H6 tree with highlights for headings that only exist on one side |
| **Content Comparison** | Text blocks, image paths, and link paths unique to each environment |
| **Performance Metrics** | Load time, DOMContentLoaded, FCP, response end, transfer size |
| **Console Messages** | Errors and warnings captured from both pages |

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

## Report structure

Each HTML report includes:

- **Summary cards** — total differences, critical differences, console issues per side
- **Screenshots** — full-page captures side by side
- **Collapsible sections** — click any section header to expand/collapse
- **Color coding** — red rows = difference, green checkmarks = match
- **Content diff tables** — text blocks, images, and links unique to Preview or Production
- **Performance bars** — visual bars with delta % highlighted if >20% difference
- **Heading tree** — unique headings (only on one side) highlighted in red
