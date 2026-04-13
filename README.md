# KraftHeinz URL Comparison Tool

Playwright-based automation that compares a **Preview** URL against a **Production** URL and generates a self-contained HTML report with a side-by-side diff.

## What it compares

| Category | Details |
|---|---|
| **Screenshots** | Full-page screenshots of both URLs, side by side |
| **Page Metadata** | Title, meta description, canonical, OG tags, robots, language, viewport |
| **HTTP Status** | Status codes and final URLs (after redirects) |
| **Page Structure** | Headings, images, links, forms, scripts, stylesheets counts |
| **Heading Structure** | Full H1–H6 tree with highlights for headings that only exist on one side |
| **Images** | Count and images missing `alt` text |
| **Performance Metrics** | Load time, DOMContentLoaded, FCP, response end, transfer size |
| **Console Messages** | Errors and warnings captured from both pages |

## Setup

### 1. Install dependencies

```bash
npm install
npm run install:browsers
```

### 2. Configure URLs

```bash
cp .env.example .env
```

Edit `.env`:

```env
PREVIEW_URL=https://your-preview-url.com
PRODUCTION_URL=https://your-production-url.com
```

## Running

```bash
npm run compare
```

The report is saved to `reports/comparison-<timestamp>.html` — open it in any browser.

### Options

```bash
# Run with a visible browser window
npm run compare:headed

# Pass URLs inline without a .env file
PREVIEW_URL=https://preview.example.com PRODUCTION_URL=https://example.com npm run compare
```

## Report structure

The HTML report is fully self-contained (screenshots are embedded as base64). It includes:

- **Summary cards** — total differences, critical differences, console issues per side
- **Screenshots** — full-page captures side by side
- **Collapsible sections** — click any section header to expand/collapse
- **Color coding** — red rows = difference, green checkmarks = match
- **Performance bars** — visual bars with delta % highlighted if >20% difference
- **Heading tree** — unique headings (only on one side) are highlighted in red
