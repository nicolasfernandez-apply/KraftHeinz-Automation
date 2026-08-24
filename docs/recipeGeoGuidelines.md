# Recipe Guidelines Automation Test Requirements

This document outlines the testing requirements derived from the Kraft Heinz Recipe GEO Guidelines. Requirements are divided into **Hard Requirements** (programmatically verifiable via DOM/schema checks) and **Soft Requirements** (requiring AI Agent evaluation for context, tone, and quality).

---

## 1. Hard Requirements (Programmatic / Deterministic Validation)

These requirements can be validated directly through Playwright using CSS selectors, JSON-LD schema parsing, regular expressions, and structural DOM assertions.

### 1.1. Structured Data & Metadata (Guideline 23)
- **JSON-LD Schema Verification**:
  - The page MUST contain a valid `<script type="application/ld+json">` representing a `Recipe` schema type.
  - The following fields MUST be present, non-empty, and correctly formatted:
    - `recipeYield` (e.g., `"4 servings"` or numeric value)
    - `prepTime` (ISO 8601 duration format, e.g., `"PT10M"`)
    - `cookTime` (ISO 8601 duration format, e.g., `"PT20M"`)
    - `totalTime` (ISO 8601 duration format, e.g., `"PT30M"`)
- **Quick Facts Block (DOM)**:
  - Structured fields for **Yield**, **Prep Time**, **Cook Time**, and **Total Time** MUST be rendered in the DOM (e.g., within the Quick Facts / `ml-text-block` component).
  - None of these fields can be blank, `null`, or contain placeholder values (e.g., `N/A`, `TBD`).

### 1.2. Method Steps Structure (Guideline 22)
- **Numbered List Structure**:
  - Method steps MUST be rendered as an ordered list (`<ol>`) or contain explicit sequential step numbers.
- **Single Action per Step (Heuristic Check)**:
  - Individual step elements should not contain multiple paragraph breaks or excessive word counts.

### 1.3. Author Attribution & Dates (NOW Roadmap)
- **Date Published**:
  - JSON-LD MUST include `datePublished` and/or `dateModified` in valid ISO 8601 date format.
- **Author Attribution**:
  - `author` field MUST exist in JSON-LD schema or as an on-page DOM element (`ml-text-block`).

### 1.4. FAQs & Interactive Components (NOW Roadmap)
- **Accordion Component State**:
  - FAQ sections using the `ml-accordion` component MUST have all content expanded by default in HTML/DOM to ensure search engine and AI crawler visibility.

---

## 2. Soft Requirements (AI Agent / Semantic Validation)

These requirements require LLM/AI Agent evaluation within the Playwright test pipeline to assess semantics, tone, compliance, and quality.

### 2.1. Opening Description Quality (Guideline 20)
- **Clear & Honest Description**:
  - Verify that the first sentence of the recipe explicitly states:
    1. What the dish is/makes.
    2. Estimated prep/cook time.
    3. The key value proposition (e.g., "tangy, caramelized weeknight dinner").
- **Backstory Elimination**:
  - Ensure the opening text skips personal anecdotes, childhood memories, or non-functional storytelling (e.g., "Growing up, my grandmother always said...").

### 2.2. Ingredient Formatting & Brand Specificity (Guideline 21)
- **Exact Quantities & Standard Measurements**:
  - Verify that all listed ingredients specify standard measurements (e.g., "2 tablespoons") rather than vague quantities (e.g., "a few squirts").
- **Full Brand Name Compliance**:
  - Confirm that Kraft Heinz brand products use their full canonical brand names (e.g., "Heinz Tomato Ketchup" or "Heinz Ketchup" instead of plain "ketchup").
- **Ingredient-Method Alignment**:
  - Verify that every ingredient mentioned in the method steps appears prior in the structured ingredient list.

### 2.3. Method Step Granularity (Guideline 22)
- **Self-Contained Single Actions**:
  - Evaluate each step to ensure it represents a single, discrete action (e.g., "Preheat the oven to 400°F.") rather than multi-action compound sentences (e.g., "Preheat your oven and while that's happening, mix together...").
- **Extractability**:
  - Ensure any single step can be extracted out of context and remain fully understandable by a reader or AI model.

### 2.4. Substitutions & Variations Section (Guideline 24)
- **Anticipated Questions**:
  - Check for a dedicated section (or FAQ block) addressing common user queries such as ingredient substitutions (e.g., alternate chicken cuts) or dietary variations (e.g., lower-sugar options).

### 2.5. Support Content & Brand Storytelling Alignment (NOW Roadmap)
- **Culinary & GEO Value Alignment**:
  - Ensure brand storytelling and tips/pro notes (`ml-text-block` or `or-creative-content-panel`) are directly tied to food outcomes, product functionality, and practical user value.