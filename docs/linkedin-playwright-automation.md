# LinkedIn Playwright Automation Plan

A detailed plan based on directly observed navigation of LinkedIn's full job search and Easy Apply flow. The key insight is that LinkedIn's Easy Apply is a **dialog/modal overlay** on top of the job page — not a separate page — and this is what trips up most Playwright selectors.

---

## Architecture Overview

The core idea is a **perceive → reason → act** loop at every step. Playwright handles browser control; the LLM handles all decisions about what to do next.

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR LOOP                    │
│                                                         │
│  Playwright captures state ──► LLM reasons ──► Act      │
│        (DOM + screenshot)        (what next?)           │
└─────────────────────────────────────────────────────────┘
```

Two complementary signals are sent to the LLM — use both:

| Signal | Best For | How |
|---|---|---|
| **Screenshot** | Detecting visual state, progress bars, validation errors, CAPTCHA | `page.screenshot()` → base64 → vision model |
| **DOM snapshot** | Reliable field targeting, getting exact selectors, reading values | `page.content()` or targeted `innerHTML` → text model |

---

## Phase 1 — Search & Filter

### Navigate directly to the search URL (most reliable)

```js
// f_WT=1,2 = Remote + Hybrid; f_AL=true = Easy Apply only
await page.goto(
  'https://www.linkedin.com/jobs/search/' +
  '?keywords=Backend%20engineer%20C%23%20ASP.NET' +
  '&location=United%20Kingdom' +
  '&f_WT=1%2C2'          // Remote + Hybrid work types
  // optionally add &f_AL=true to filter Easy Apply only
);
```

### ✅ Key Insight

Do **NOT** rely on clicking the search bar and pressing Enter. LinkedIn's search bar uses a `combobox` with autocomplete that requires selecting a dropdown suggestion. The `<input>` in the nav bar has the role `combobox`, and pressing Enter often submits a generic search or does nothing if autocomplete hasn't resolved. **The URL-based approach is 100% reliable.**

### TypeScript version with parameters

```ts
await page.goto(
  `https://www.linkedin.com/jobs/search/` +
  `?keywords=${encodeURIComponent(keywords)}` +
  `&location=${encodeURIComponent(location)}` +
  `&f_WT=1%2C2`  // Remote + Hybrid
);
```

---

## Phase 2 — Scrape & Score Job Listings

### Wait for job cards (use stable structural selectors)

```js
// LinkedIn uses an Ember.js SPA. The key pattern is:
// waitForSelector on a STABLE structural element, never on generated class names.
await page.waitForSelector('ul.scaffold-layout__list-container li',
  { timeout: 10000 });
// OR more robustly:
await page.waitForSelector('.jobs-search-results__list-item', { timeout: 15000 });
```

### Scrape job cards

```js
// Each job card is a <li> inside the results list
const jobCards = await page.$$('li.jobs-search-results__list-item');

for (const card of jobCards) {
  // Job title link — this is the ONLY stable selector
  const titleEl = await card.$('a[data-control-name="job_card_title"]');
  // If that fails, use: a[href*="/jobs/view/"]

  const title = await titleEl?.textContent();
  const href  = await titleEl?.getAttribute('href');
  const jobId = href?.match(/\/jobs\/view\/(\d+)/)?.[1];

  // Check for Easy Apply badge BEFORE clicking
  const easyApplyBadge = await card.$('li-icon[type="linkedin-bug"]');
  // OR: look for text "Easy Apply" inside the card
  const isEasyApply = await card.$eval(
    '.job-card-container__apply-method',
    el => el?.textContent?.includes('Easy Apply')
  ).catch(() => false);
}
```

### Structured scrape (TypeScript, in-page evaluate)

```ts
const jobs = await page.evaluate(() => {
  return Array.from(
    document.querySelectorAll('.jobs-search-results__list-item')
  ).map(card => {
    const titleEl = card.querySelector('a[href*="/jobs/view/"]');
    const href = titleEl?.getAttribute('href') ?? '';
    const jobId = href.match(/\/jobs\/view\/(\d+)/)?.[1] ?? '';

    // Easy Apply detection — look for the li-icon bug logo next to "Easy Apply" text
    const applyText = card.querySelector('.job-card-container__apply-method')?.textContent ?? '';
    const isEasyApply = applyText.includes('Easy Apply');

    return {
      jobId,
      title: titleEl?.textContent?.trim() ?? '',
      company: card.querySelector('.job-card-container__primary-description')?.textContent?.trim() ?? '',
      location: card.querySelector('.job-card-container__metadata-item')?.textContent?.trim() ?? '',
      snippet: card.textContent?.trim().substring(0, 300) ?? '',
      isEasyApply,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`
    };
  });
});
```

### ✅ Key Insight — Lazy Loading

LinkedIn renders job cards lazily. You must scroll the **left panel** (not the page body) to trigger rendering of all cards before scraping.

### Why selectors break

LinkedIn uses generated CSS class names (e.g. `scaffold-layout__list-container`) that are semi-stable, but internal card classes change. The most robust selector is `a[href*="/jobs/view/"]` — it relies on URL structure, not class names.

### LLM Scoring Call

Send all scraped jobs to the LLM with the CV to pick the best one:

```ts
async function scoreJobs(jobs: Job[], cvText: string): Promise<Job> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: `You are a job application assistant.

CV:
${cvText}

Jobs (JSON):
${JSON.stringify(jobs, null, 2)}

Task: Return ONLY the index (0-based) of the best matching job for this CV.
Consider: title relevance, tech stack match, seniority level.
Respond with JSON: { "bestIndex": <number>, "reason": "<1 sentence>" }`
    }]
  });

  const result = JSON.parse(response.choices[0].message.content!);
  return jobs[result.bestIndex];
}
```

---

## Phase 3 — Open a Job & Check Apply Type

### Navigate directly to the job detail page

```ts
await page.goto(`https://www.linkedin.com/jobs/view/${jobId}/`);
await page.waitForLoadState('networkidle');
```

### Detect Easy Apply vs External

```ts
// ─── KEY INSIGHT: LinkedIn renders "Easy Apply" as an <a> tag (not a button) ──
// The actual DOM: <a class="jobs-apply-button" href="/jobs/view/{id}/apply/?openSDUIApplyFlow=true">
// Selector priority order (most to least stable):
//   1. aria-label attribute
//   2. href pattern containing "/apply/"
//   3. text content "Easy Apply"

const applyBtn = page.locator(
  '[aria-label="Easy Apply to this job"], a[href*="/apply/?openSDUIApplyFlow"]'
);
const externalBtn = page.locator(
  'button.jobs-apply-button:not([href*="easy"]), a[data-tracking-control-name*="external"]'
);

const isEasyApply = await applyBtn.count() > 0;

if (!isEasyApply) {
  // ─── EXTERNAL APPLY — intercept the new tab popup ─────────────────────
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    externalBtn.click()
  ]);
  const externalUrl = popup.url();
  await popup.close();
  return { type: 'external', url: externalUrl };
}
```

### Why this matters

External apply buttons on LinkedIn open in a new tab (popup). Your bot must use `page.waitForEvent('popup')` to capture the URL, not try to read a redirect from the current page.

### Optional: LLM Vision Check

```ts
// Take screenshot and ask LLM what type of apply button is present
async function detectApplyType(page: Page): Promise<'easy' | 'external' | 'none'> {
  const screenshot = await page.screenshot({ encoding: 'base64' });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } },
        { type: 'text', text: `Look at this LinkedIn job page screenshot.
Is there an "Easy Apply" button (LinkedIn's own flow) or an external "Apply" button?
Respond with JSON only: { "type": "easy" | "external" | "none", "buttonText": "<exact text you see>" }` }
      ]
    }]
  });

  return JSON.parse(response.choices[0].message.content!).type;
}
```

---

## Phase 4 — Easy Apply Flow (Modal Dialog)

The Easy Apply modal has multiple dynamic steps. There are two approaches: a **hardcoded step-by-step** version (simpler, more brittle), and an **LLM-guided loop** (more robust, handles unknown questions).

### Opening the Modal (Reliably)

```ts
// ─── KEY INSIGHT: Navigate directly to the apply URL ──────────────────────
// Clicking the button sometimes fails to open the modal in Playwright due to
// focus/interceptor conflicts. Direct navigation is 100% reliable.
await page.goto(
  `https://www.linkedin.com/jobs/view/${jobId}/apply/?openSDUIApplyFlow=true`
);
await page.waitForLoadState('networkidle');

// The page redirects back to /jobs/view/{id}/ but the modal loads asynchronously.
// Wait for the modal container, then wait for the loader spinner to disappear.
await page.waitForSelector('.jobs-easy-apply-modal', { timeout: 10000 });
await page.waitForSelector('.jobs-easy-apply-modal .jobs-loader',
  { state: 'detached', timeout: 10000 });

// The modal is also addressable as role="dialog"
const modal = page.locator('[role="dialog"], .jobs-easy-apply-modal');
await modal.waitFor({ state: 'visible' });
```

---

### Approach A — Hardcoded Step-by-Step

Use this when you know the exact field layout. Brittle if LinkedIn changes the form.

#### Step 1: Contact Info

```js
// Progress indicator: aria-label="Your job application progress is at 0 percent"

// Email dropdown (select by value or text)
await modal.locator('select').first().selectOption({ label: 'your@email.com' });

// Phone country code
await modal.locator('select').nth(1).selectOption({ label: 'United Kingdom (+44)' });

// Phone number
await modal.locator('input[name*="phone"], input[placeholder*="phone"]')
  .fill('07XXXXXXXXX');

// Continue button
await modal.locator('button:has-text("Continue")').click();
await page.waitForTimeout(1500); // wait for next step to render
```

#### Step 2: Resume Upload / CV

```js
// LinkedIn usually shows your saved resume or asks to upload one
const resumeSection = modal.locator('h3:has-text("Resume")').first();
if (await resumeSection.isVisible()) {
  // If upload needed:
  const fileInput = modal.locator('input[type="file"]');
  await fileInput.setInputFiles('/path/to/your-cv.pdf');
  await modal.locator('button:has-text("Upload")').click();
}
await modal.locator('button:has-text("Continue"), button:has-text("Next")').click();
```

#### Subsequent Steps: Dynamic Questions Loop

```js
// LinkedIn may ask screening questions. Loop until the Submit button appears.
while (true) {
  const submitBtn = modal.locator('button:has-text("Submit application")');
  const continueBtn = modal.locator(
    'button:has-text("Continue"), button:has-text("Next")'
  );

  const hasSubmit = await submitBtn.count() > 0;
  if (hasSubmit) {
    await submitBtn.click();
    break;
  }

  // Handle any visible text inputs / selects / radio buttons
  // ... (LLM can parse modal.textContent() here to decide answers)

  await continueBtn.click();
  await page.waitForTimeout(1500);
}
```

#### Confirmation

```js
await modal.locator('text=Your application was sent').waitFor({ timeout: 10000 });
```

---

### Approach B — LLM-Guided Step Loop (Recommended)

The most important pattern. The modal has multiple dynamic steps — the LLM drives every one.

#### The Core Loop

```ts
async function runEasyApplyLoop(page: Page, cvData: CVData) {
  const modal = page.locator('.jobs-easy-apply-modal');

  while (true) {
    // ─── Wait for step to fully render (no spinner) ──────────────────────
    await page.waitForSelector('.jobs-easy-apply-modal .jobs-loader',
      { state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500); // small settle time

    // ─── Capture state: BOTH DOM and screenshot ──────────────────────────
    const domSnapshot = await captureModalDOM(page);
    const screenshot  = await page.screenshot({ encoding: 'base64' });

    // ─── Ask LLM what to do ──────────────────────────────────────────────
    const action = await askLLMNextAction(domSnapshot, screenshot, cvData);

    // ─── Execute the action ──────────────────────────────────────────────
    if (action.type === 'done') break;
    await executeAction(page, action);
    await page.waitForTimeout(800);
  }
}
```

#### DOM Snapshot Function

```ts
async function captureModalDOM(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const modal = document.querySelector('.jobs-easy-apply-modal');
    if (!modal) return 'Modal not found';

    // Extract structured representation — not raw HTML (too noisy)
    const elements: string[] = [];

    modal.querySelectorAll(
      'h1,h2,h3,h4,label,input,select,textarea,button,[role="radio"],[role="checkbox"]'
    ).forEach(el => {
      const tag      = el.tagName.toLowerCase();
      const label    = el.getAttribute('aria-label') || el.textContent?.trim().substring(0, 80) || '';
      const type     = el.getAttribute('type') || '';
      const name     = el.getAttribute('name') || el.id || '';
      const value    = (el as HTMLInputElement).value || '';
      const selected = tag === 'select'
        ? (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]?.text
        : '';
      const required = el.getAttribute('aria-required') || el.getAttribute('required') || '';
      const options  = tag === 'select'
        ? Array.from((el as HTMLSelectElement).options).map(o => o.text).join(' | ')
        : '';

      elements.push(
        `[${tag}${type ? ' type='+type : ''}]` +
        ` label="${label}"` +
        (name     ? ` name="${name}"` : '') +
        (value    ? ` value="${value}"` : '') +
        (selected ? ` selected="${selected}"` : '') +
        (required ? ' REQUIRED' : '') +
        (options  ? ` options=[${options.substring(0,100)}]` : '')
      );
    });

    return elements.join('\n');
  });
}
```

#### LLM Action Decision Function

```ts
interface Action {
  type: 'fill' | 'select' | 'click' | 'upload' | 'done' | 'error';
  selector?: string;   // CSS selector
  ariaLabel?: string;  // aria-label to target (preferred over selector)
  value?: string;
  filePath?: string;
}

async function askLLMNextAction(
  domSnapshot: string,
  screenshotBase64: string,
  cvData: CVData
): Promise<Action> {

  const systemPrompt = `You are controlling a Playwright browser to fill in a LinkedIn Easy Apply form.
You receive:
1. A DOM snapshot of the modal (structured text showing all form fields)
2. A screenshot of the modal

CV data available:
${JSON.stringify(cvData, null, 2)}

Your job: Look at the current state and return the SINGLE next action to take.

Return JSON in exactly this format:
{
  "type": "fill" | "select" | "click" | "upload" | "done" | "error",
  "ariaLabel": "<aria-label of the target element>",  // PREFERRED
  "selector": "<CSS selector as fallback>",           // only if no aria-label
  "value": "<value to fill/select>",                  // for fill/select
  "filePath": "<path>",                               // for upload only
  "reasoning": "<brief explanation>"
}

Rules:
- If all fields on current step are filled and there's a Continue/Next/Review button, click it
- If you see "Submit application" button and all looks good, click it → type="done"
- If you see an error message, return type="error" with reasoning
- NEVER guess a selector — derive it from the DOM snapshot
- For phone fields, use the value from cvData.phone
- For "Are you authorized to work in UK?" type questions, answer Yes
- For salary expectations, use cvData.expectedSalary`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `DOM Snapshot:\n${domSnapshot}\n\nWhat is the next action?`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${screenshotBase64}` }
        }
      ]
    }],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content!) as Action;
}
```

#### Action Executor

```ts
async function executeAction(page: Page, action: Action) {
  const modal = page.locator('.jobs-easy-apply-modal');

  // Locate element — prefer aria-label, fall back to selector
  const target = action.ariaLabel
    ? modal.locator(`[aria-label="${action.ariaLabel}"]`).first()
    : modal.locator(action.selector!).first();

  switch (action.type) {
    case 'fill':
      await target.waitFor({ state: 'visible', timeout: 5000 });
      await target.clear();
      await target.fill(action.value!);
      break;

    case 'select':
      await target.selectOption({ label: action.value! });
      break;

    case 'click':
      await target.waitFor({ state: 'visible', timeout: 5000 });
      await target.click();
      // Wait for next step to load
      await page.waitForSelector('.jobs-easy-apply-modal .jobs-loader',
        { state: 'detached', timeout: 8000 }).catch(() => {});
      break;

    case 'upload':
      // For resume upload — file inputs are hidden, use setInputFiles
      const fileInput = modal.locator('input[type="file"]');
      await fileInput.setInputFiles(action.filePath!);
      break;

    case 'done':
      // Application submitted — loop will break
      break;
  }
}
```

---

## Phase 5 — Error Recovery with LLM

After each action, validate with a screenshot before continuing:

```ts
async function validateStep(page: Page): Promise<boolean> {
  const screenshot = await page.screenshot({ encoding: 'base64' });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } },
        { type: 'text', text: `Look at this LinkedIn Easy Apply modal screenshot.
Are there any validation errors shown (red borders, error text, warnings)?
Respond JSON: { "hasErrors": true/false, "errors": ["<error text>"] }` }
      ]
    }]
  });

  const result = JSON.parse(response.choices[0].message.content!);
  if (result.hasErrors) {
    console.log('Validation errors detected:', result.errors);
    return false;
  }
  return true;
}
```

---

## Key Observations from Live Walkthrough

From walking through LinkedIn's UI live, here's what's critical:

### 1. The Easy Apply button is an `<a>` tag, not a `<button>`

The DOM is: `<a class="jobs-apply-button" href="/jobs/view/{id}/apply/?openSDUIApplyFlow=true">`

Playwright's `page.click('button:has-text("Easy Apply")')` will silently fail because it's a link. Use `page.goto(applyUrl)` instead.

### 2. The modal content lazy-loads

When the modal first opens, it only contains a loading spinner (`.jobs-loader`). The form fields load via an API call ~1–2 seconds later. Your bot must `waitForSelector('.jobs-loader', { state: 'detached' })` before reading the DOM.

### 3. Screenshot tool conflicts when modal is open

Screenshots can fail while the modal is active (a Playwright/extension interaction pattern). The solution: use `page.screenshot()` from within Playwright itself (not the extension) — this always works.

### 4. The modal class is stable: `.jobs-easy-apply-modal`

Scope all selectors to this class. Don't search the full document — only search inside the modal to avoid false matches on the background page.

### 5. Progress is tracked by `aria-label="Your job application progress is at X percent"`

Use this to know which step you're on without counting clicks.

---

## Key Fixes Summary

| Problem | Root Cause | Fix |
|---|---|---|
| Search doesn't trigger | `combobox` input needs autocomplete click, not Enter | Navigate directly to search URL with query params |
| Job card selectors break | Generated CSS class names change | Use `a[href*="/jobs/view/"]` and text-based selectors |
| Easy Apply modal doesn't open | Click on button conflicts with focus/overlay | Navigate directly to `/jobs/view/{id}/apply/?openSDUIApplyFlow=true` |
| External apply URL not captured | LinkedIn opens it in a new tab | Use `page.waitForEvent('popup')` before clicking apply |
| Modal fields not found | Searching entire page DOM | Scope all selectors inside `[role="dialog"]` or `.jobs-easy-apply-modal` |
| Steps not advancing | No wait between steps | Always `waitFor({ state: 'visible' })` on next step's element, plus wait for `.jobs-loader` to detach |
| Easy Apply click silently fails | It's an `<a>` tag, not a `<button>` | Use `page.goto(applyUrl)` instead of clicking |
| Modal reads empty/wrong fields | Modal content loads asynchronously after spinner | Wait for `.jobs-loader` to detach before reading DOM |
