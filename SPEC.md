# SERM Snapshot — Technical Specification

## Project overview

A Chrome extension that analyzes the visual blocks of a Google SERP (organic results, AI Overview, knowledge panel, People Also Ask, carousels) on branded queries and produces a one-screen reputation snapshot. All AI processing happens locally via the Chrome Built-in Prompt API (Gemini Nano) — zero server calls, zero API keys, zero data leaving the user's device.

**Target user:** SEO/SERM specialists who need to quickly assess a client's reputation on a branded query without paying $50–200/month for tools like Authoritas, Otterly, or Profound.

**Core value proposition:** Free, private, instant SERP reputation snapshot.

---

## Tech stack

- **Manifest V3** Chrome extension
- **Vanilla JavaScript** (ES modules) — no frameworks, no build step
- **Chrome Side Panel API** (`chrome.sidePanel`) for the UI
- **Chrome Built-in Prompt API** (`LanguageModel`) for analysis
- **No external dependencies** — everything ships with the extension

---

## Hard requirements

The extension only runs when ALL of these are true:

1. Chrome 138+ on desktop (Windows 10/11, macOS 13+, Linux, ChromeOS on Chromebook Plus)
2. At least 22 GB free disk space (for Gemini Nano model)
3. GPU with > 4 GB VRAM, OR CPU with 16 GB RAM + 4+ cores
4. Unmetered internet connection (only for initial model download)
5. Active tab is `https://www.google.com/search?*`

If requirements aren't met, the extension shows a clear error state in the side panel with a link to the Chrome documentation.

---

## File structure

```
serm-snapshot/
├── manifest.json
├── background.js                   # service worker, opens side panel
├── content/
│   ├── content.js                  # main content script, orchestrates extraction
│   ├── extractors/
│   │   ├── ai-overview.js
│   │   ├── knowledge-panel.js
│   │   ├── featured-snippet.js
│   │   ├── people-also-ask.js
│   │   ├── organic.js
│   │   ├── twitter-carousel.js
│   │   ├── reddit-carousel.js
│   │   ├── news-carousel.js
│   │   ├── video-carousel.js
│   │   └── reviews-snippet.js
│   └── utils.js                    # shared DOM helpers
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js                # UI logic + Prompt API calls
├── lib/
│   ├── prompt-runner.js            # Prompt API wrapper
│   ├── analyzer.js                 # aggregates results, computes score
│   ├── exporters.js                # markdown / JSON / CSV
│   └── messages.js                 # constants for chrome.runtime messaging
├── prompts/
│   ├── system.js                   # system prompt builder
│   └── schemas.js                  # JSON Schemas for structured output
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Manifest

```json
{
  "manifest_version": 3,
  "name": "SERM Snapshot",
  "version": "0.1.0",
  "description": "Local AI-powered SERP reputation snapshot for branded queries.",
  "permissions": ["sidePanel", "activeTab", "storage", "scripting"],
  "host_permissions": [
    "https://www.google.com/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "Open SERM Snapshot"
  },
  "content_scripts": [
    {
      "matches": ["https://www.google.com/search*"],
      "js": ["content/content.js"],
      "type": "module",
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

---

## User flow

### First-time setup

1. User installs the extension.
2. User navigates to a Google SERP for a branded query (e.g., `example.com`).
3. User clicks the extension icon → side panel opens.
4. Side panel asks: "What brand are you analyzing? In one sentence, describe what they do."
   - Brand name (free text)
   - Brand description (free text, e.g., "B2B HR analytics SaaS for European mid-market companies")
   - This is stored in `chrome.storage.local` keyed by URL host of the SERP, so the user doesn't re-enter for the same client.
5. User clicks **Analyze SERP**.

### Analysis flow

1. Side panel sends a `runExtraction` message to the active tab's content script.
2. Content script runs all extractors in parallel; each returns `{ blockType, found: bool, data: [...] }`.
3. Content script returns aggregated extraction payload to side panel.
4. Side panel shows progress UI: "Found 11 blocks. Analyzing..."
5. Side panel batches blocks (3–5 per prompt) and calls `LanguageModel.prompt()` with `responseConstraint: schema`.
6. Each batch returns structured analysis (sentiment, brand visibility, risk flag, etc.).
7. Side panel aggregates results, computes the Reputation Score, renders the report.
8. Export buttons become active.

### Re-runs

- "Re-analyze" button reruns extraction on the current tab. No caching across runs (SERPs change too fast to cache reliably).
- History view: last 20 snapshots stored locally with timestamp and query. Allows comparison over time.

---

## Block extractors

Each extractor is a self-contained ES module that exports:

```js
export const blockType = 'ai-overview'; // unique identifier

export function extract(document) {
  // Returns: { found: boolean, data: ExtractedBlock[] }
  // ExtractedBlock shape varies per type but always includes:
  //   - blockType: string
  //   - position: number (DOM order on page)
  //   - text: string (raw text content for the model)
  //   - sourceUrl?: string
  //   - sourceTitle?: string
  //   - sourceDomain?: string
}
```

### Extractor priority and selectors

Selectors are inherently fragile. Each extractor tries 2–3 fallback selectors and uses content-shape heuristics as a last resort.

#### 1. AI Overview (`ai-overview.js`)
- Primary selectors: `[data-attrid*="GenerativeAI"]`, `div[jsname][data-rl]` containing characteristic AIO markers.
- Heuristic: container text starts with synthesized summary (multiple sentences referring to multiple sources via inline citation markers).
- Extract: full text, list of cited URLs, list of cited domains.

#### 2. Knowledge Panel (`knowledge-panel.js`)
- Primary selector: `div[data-attrid="kc:/business/business"]`, `.kp-wholepage`, `.knowledge-panel`.
- Extract: panel title, subtitle/category, description text, cited links (Wikipedia, official site, social).

#### 3. Featured Snippet (`featured-snippet.js`)
- Primary selectors: `div[data-attrid="wa:/description"]`, `.kp-blk .ifM9O`, blocks with `.LGOjhe` content.
- Extract: snippet text, source URL, source title.

#### 4. People Also Ask (`people-also-ask.js`)
- Primary selector: `div[jsname="N760b"]`, `.related-question-pair`, `[data-initq]`.
- Extract: array of `{ question, expandedAnswer?, sourceUrl, sourceDomain }`.
- Note: PAA expanded answers may not be in DOM until clicked. If not present, just capture the question — that itself is a reputation signal.

#### 5. Organic results (`organic.js`)
- Primary selector: `#search div[data-hveid]` containing `.yuRUbf > a`.
- Extract for each result in top 10:
  - position (1-indexed)
  - url, domain, title, snippet
  - hasRichSnippet (boolean — rating, sitelinks, etc. present)

#### 6. Twitter/X carousel (`twitter-carousel.js`)
- Heuristic: detect carousel containing twitter.com / x.com links with timeline-style snippets.
- Extract: array of `{ author, text, date?, url }`.

#### 7. Reddit/forum carousel (`reddit-carousel.js`)
- Heuristic: detect "Discussions and forums" section, or carousel of reddit.com / quora.com / stackexchange links.
- Extract: array of `{ title, subreddit/forum, snippet, url }`.

#### 8. News carousel (`news-carousel.js`)
- Selector: `g-section-with-header` containing news-style cards with publisher logos.
- Extract: array of `{ headline, publisher, date, url }`.

#### 9. Video carousel (`video-carousel.js`)
- Selector: containers with youtube.com / vimeo.com links and thumbnail images.
- Extract: array of `{ title, channel, url, duration? }`.

#### 10. Reviews snippet (`reviews-snippet.js`)
- Heuristic: any organic result with rating/review-count microdata visible in the snippet.
- Extract: `{ url, rating, reviewCount, ratingSource }`.

### Robustness rules for extractors

- Each extractor wraps its main logic in try/catch. On error: log to console, return `{ found: false, data: [] }`. Never throws.
- `console.warn('[serm-snapshot] extractor X failed', err)` so contributors can see what broke.
- The orchestrator `content.js` runs `Promise.allSettled` on all extractors. One broken extractor doesn't break the snapshot.

---

## Prompt API integration

### Availability check

On side panel load, run:

```js
const availability = await LanguageModel.availability({
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
});
```

Possible states and UI response:

| State | UI |
|-------|----|
| `unavailable` | Show error card with hardware requirements + link to docs |
| `downloadable` | Show "Download model (~2 GB)" button; on click, call `create()` with `monitor` for progress |
| `downloading` | Show progress bar tied to `downloadprogress` event |
| `available` | Enable Analyze button |

### Session creation

One session per analysis run, destroyed after the run to free resources. No persistent sessions.

```js
const session = await LanguageModel.create({
  initialPrompts: [
    { role: 'system', content: buildSystemPrompt(brandContext) }
  ],
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
});
```

### Per-batch prompts

Blocks are batched (3–5 per prompt) to reduce overhead. Each prompt:

1. Includes the brand context in the system prompt (set at session creation).
2. Sends a JSON array of blocks as user content.
3. Uses `responseConstraint` with the per-batch schema (see `PROMPTS.md`).

### Context window handling

- After every prompt, log `session.contextUsage / session.contextWindow`.
- If usage exceeds 75%, destroy the session and create a new one for remaining batches (with the same system prompt).
- Listen for `contextoverflow` event as a safety net.

### Error handling

Wrap every `prompt()` call in try/catch. Errors:

- `QuotaExceededError`: split the batch in half, retry.
- `NotSupportedError`: log and skip the batch; mark its blocks as "analysis failed" in the report.
- Generic: log, mark as failed, continue.

A failed batch never breaks the run. The final report shows how many blocks were analyzed vs skipped.

---

## Analyzer (aggregation logic)

### Per-block enrichment

Each block from the model returns:

```ts
{
  blockType: string;
  position: number;
  sentiment: 'positive' | 'neutral' | 'mixed' | 'negative';
  brandVisibility: 'title' | 'snippet' | 'url-only' | 'none';
  relevance: 'on-topic' | 'tangential' | 'off-topic';
  risk: { flag: boolean; reasons: string[] };
  ownership: 'owned' | 'earned' | 'third-party';
  oneLineSummary: string;
}
```

### Ownership detection (deterministic, not via model)

- `owned`: domain matches brand's official domain or known social handles (user-entered list during setup).
- `earned`: third-party domain with positive sentiment.
- `third-party`: everything else.

The model is told the official domain in the system prompt and instructed to flag it, but the analyzer makes the final ownership call by string-matching.

### Reputation Score (0–100)

A simple weighted formula. Stays simple on purpose so users can understand and trust it.

```
positiveWeight = 1.0
neutralWeight  = 0.5
mixedWeight    = 0.25
negativeWeight = 0.0
ownedBonus     = 0.2  // added on top of block weight if owned, capped at 1.0

blockScore = weightFor(sentiment) + (isOwned ? ownedBonus : 0)
totalScore = sum(blockScore * positionWeight) / sum(positionWeight)

positionWeight: 
  - position 1-3: 1.0
  - position 4-6: 0.7
  - position 7-10: 0.5
  - non-organic blocks: 0.8 (AIO=1.0, KP=1.0, FS=0.9, PAA=0.6)

finalScore = round(totalScore * 100)
```

The score is intentionally rough — it's a directional signal, not a precise metric. README will say so.

### Aggregate counts

Side panel shows:

- Total blocks analyzed
- Sentiment breakdown (counts and percentages)
- Top 3 risk flags (blocks with `risk.flag === true`, sorted by position)
- Brand control breakdown (owned / earned positive / third-party neutral / third-party negative)

---

## Side panel UI

### Layout

Single-column scrollable panel, 400px wide.

```
┌──────────────────────────────┐
│ SERM Snapshot                │ ← header
│ Query: "[brand]"             │
├──────────────────────────────┤
│ [Brand context card]         │ ← collapsible after first set
│ - Brand: example.com         │
│ - Description: ...           │
│ - [Edit]                     │
├──────────────────────────────┤
│ [Big score card]             │ ← prominent
│   71/100                     │
│   Reputation Score           │
├──────────────────────────────┤
│ Sentiment breakdown          │
│ 🟢 6 (43%)  🟡 5  🔴 2  ⚫ 1 │
├──────────────────────────────┤
│ Top risks (2)                │
│ - Position #4: "alternatives"│
│ - PAA: "Is X legit?"         │
├──────────────────────────────┤
│ Block-by-block               │ ← expandable list
│ ▶ AI Overview (neutral)      │
│ ▶ Knowledge Panel (owned)    │
│ ▶ #1 [domain] (positive)     │
│ ...                          │
├──────────────────────────────┤
│ [Re-analyze] [Export ▼]      │ ← bottom actions
│              ├ Markdown      │
│              ├ JSON          │
│              └ CSV           │
└──────────────────────────────┘
```

### States

1. **No SERP open** — empty state with instructions.
2. **Brand context not set** — onboarding form.
3. **Model unavailable** — error card with hardware reqs.
4. **Model downloading** — progress bar + "this is a one-time download".
5. **Ready** — Analyze button prominent.
6. **Analyzing** — progress indicator with `Extracted N blocks · Analyzing batch X of Y`.
7. **Results** — full report.
8. **Error** — graceful error message with "what failed" + "what to try".

### Visual style

Minimal, neutral. White background, system font, single accent color (suggest `#2D7FF9`). No flashy colors. Sentiment uses standard emoji (🟢🟡🔴⚫) — no custom icons needed.

CSS file should be < 200 lines. No animations beyond a subtle progress spinner.

---

## Export formats

### Markdown

```markdown
# SERM Snapshot — [brand] — 2026-04-27

**Query:** "[exact query]"
**Reputation Score:** 71/100

## Sentiment Breakdown
- 🟢 Positive: 6 (43%)
- 🟡 Neutral: 5 (36%)
- 🔴 Negative: 2 (14%)
- ⚫ Mixed: 1 (7%)

## Top Risks
1. **Position #4 (organic)** — "[brand] alternatives": competitor comparison article
2. **People Also Ask** — "Is [brand] legit?": surfaces complaints

## Block-by-block

### AI Overview (neutral, third-party)
> Cited domains: en.wikipedia.org, example.com, g2.com
> [one-line summary from model]

### Position #1: example.com (positive, owned)
...
```

### JSON

Full structured data dump including raw extracted text and per-block analysis. For developers who want to pipe into their own tooling.

### CSV

One row per block with columns: `position, blockType, domain, url, title, sentiment, brandVisibility, ownership, riskFlag, summary`.

---

## Storage schema

`chrome.storage.local`:

```js
{
  // Brand context, keyed by SERP host (always google.com but kept flexible)
  "brandContext:google.com": {
    brandName: "example.com",
    brandDescription: "B2B HR analytics SaaS",
    officialDomains: ["example.com"],
    socialHandles: ["@example", "linkedin.com/company/example"],
    updatedAt: 1714237200000
  },
  // Last 20 snapshots
  "history": [
    {
      id: "uuid",
      query: "[brand]",
      timestamp: 1714237200000,
      score: 71,
      sentimentCounts: { positive: 6, neutral: 5, mixed: 1, negative: 2 },
      // full report data
    }
    // ...
  ],
  // User preferences
  "preferences": {
    autoAnalyze: false, // analyze automatically when SERP opens
    defaultExportFormat: "markdown"
  }
}
```

---

## Non-goals (explicitly out of scope for v0.1)

- Bulk URL analysis. This is single-SERP only.
- Cross-SERP tracking over time (beyond simple history of past snapshots). Trend graphs are v0.2.
- Cloud sync. Everything is local.
- Non-Google search engines. v0.2 candidate.
- Mobile SERP support. Desktop only — Prompt API doesn't run on mobile anyway.
- Localized SERPs beyond `google.com`. Extractors will likely break on country-specific TLDs; documented as a known limitation.
- Custom prompt editing by users. Prompts are fixed in v0.1 to ensure consistent output.

---

## Known limitations (must be documented in README)

1. Google's DOM changes regularly. Extractors will need maintenance — open-source contributions encouraged.
2. Sentiment on short snippets is imperfect. Treat scores as directional, not precise.
3. Gemini Nano has a small context window. Large SERPs may require multiple model sessions, slightly slowing analysis.
4. First run requires a ~2 GB model download.
5. Hardware requirements exclude many laptops (especially older or low-RAM machines).

---

## Testing checklist (manual, pre-publish)

- [ ] Works on a SERP with all 10 block types present.
- [ ] Works on a SERP with only organic results.
- [ ] Works on a SERP with no AIO.
- [ ] Handles model `unavailable` gracefully.
- [ ] Handles model `downloading` with progress UI.
- [ ] Handles `QuotaExceededError` (test with a giant SERP).
- [ ] Brand context persists across re-runs.
- [ ] All three export formats produce valid output.
- [ ] Re-analyze on a different query reuses the same brand context if the brand name matches.
- [ ] Score formula produces expected values on hand-crafted test data.
- [ ] No errors thrown to user when one extractor fails (simulated by breaking a selector).

---

## Versioning and roadmap

**v0.1.0 (this MVP):** everything above.

**v0.2 candidates:**
- Trend graphs for branded queries over time
- Comparison mode (this SERP vs last week's)
- Custom block weighting
- bing.com support

**v1.0 candidate:**
- Bulk mode: analyze a list of branded queries via background tab cycling
