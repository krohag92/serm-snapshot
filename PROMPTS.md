# SERM Snapshot — Prompts & Schemas

This document contains every prompt and JSON Schema used by the extension. All prompts are designed for Gemini Nano (small model, limited context). Keep them short, deterministic, and structured.

---

## System prompt builder

Built once per session, includes the user-provided brand context.

```js
// prompts/system.js
export function buildSystemPrompt({ brandName, brandDescription, officialDomains, socialHandles }) {
  return `You are a SERM (search engine reputation management) analyst.
You analyze blocks of a Google search results page about a specific brand and classify each block.

BRAND BEING ANALYZED:
- Name: ${brandName}
- Description: ${brandDescription}
- Official domains: ${officialDomains.join(', ')}
- Official social handles: ${socialHandles.join(', ') || 'none provided'}

YOUR TASK:
For each block provided, return:
1. sentiment toward the brand: "positive" | "neutral" | "mixed" | "negative"
2. brandVisibility: where the brand name appears: "title" | "snippet" | "url-only" | "none"
3. relevance: "on-topic" (clearly about this brand) | "tangential" (mentions brand but main topic differs) | "off-topic" (different entity, e.g. namesake)
4. risk: an object with { flag: boolean, reasons: string[] }
   - flag is true when the block could damage the brand's reputation if a prospect saw it
   - reasons should be concrete (e.g. "compares brand unfavorably to competitor", "surfaces complaint", "uses negative trigger word: 'scam'")
5. ownership: "owned" if the source domain matches an official domain or social handle, "earned" if third-party with positive sentiment, "third-party" otherwise
6. oneLineSummary: a single sentence (max 20 words) describing what this block says about the brand

RULES:
- Be conservative on sentiment. Default to "neutral" unless there is clear positive or negative language.
- "positive" means actively favorable (praise, recommendation, success story).
- "negative" means actively unfavorable (criticism, complaint, comparison-against, warning).
- "mixed" means both positive and negative signals in the same block.
- "off-topic" matters: if the brand name is a common word and the block is about something else entirely, mark off-topic. Don't apply sentiment to off-topic blocks (default neutral).
- Do not invent information. If the block doesn't contain enough text to judge, default to neutral and note in oneLineSummary.

Output strictly conforms to the schema. No prose, no explanations outside the JSON.`;
}
```

---

## Per-batch user prompt

Sent for each batch of 3–5 blocks.

```js
// content sent as user message
function buildBatchPrompt(blocks) {
  return `Analyze these ${blocks.length} SERP blocks. Return a JSON array with one analysis object per block, in the same order.

BLOCKS:
${JSON.stringify(blocks, null, 2)}`;
}
```

Each block in the array passed to the model has this minimal shape (extractors strip raw HTML; only what the model needs):

```ts
{
  blockType: string;       // e.g. "organic", "ai-overview", "people-also-ask"
  position: number;        // DOM position (1 = first on page)
  text: string;            // the visible text content of the block, truncated to ~500 chars
  sourceDomain?: string;   // for blocks with a source
  sourceUrl?: string;
  sourceTitle?: string;
}
```

For carousels (Twitter, Reddit, news, video), each item in the carousel is sent as a separate block, not bundled. This makes per-source sentiment cleaner.

---

## JSON Schemas

### Per-batch response schema

This is what gets passed as `responseConstraint` on every `prompt()` call.

```js
// prompts/schemas.js
export const batchAnalysisSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'mixed', 'negative']
      },
      brandVisibility: {
        type: 'string',
        enum: ['title', 'snippet', 'url-only', 'none']
      },
      relevance: {
        type: 'string',
        enum: ['on-topic', 'tangential', 'off-topic']
      },
      risk: {
        type: 'object',
        properties: {
          flag: { type: 'boolean' },
          reasons: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['flag', 'reasons']
      },
      ownership: {
        type: 'string',
        enum: ['owned', 'earned', 'third-party']
      },
      oneLineSummary: {
        type: 'string'
      }
    },
    required: [
      'sentiment',
      'brandVisibility',
      'relevance',
      'risk',
      'ownership',
      'oneLineSummary'
    ]
  }
};
```

### Brand setup form (no model involved, just for reference)

```ts
{
  brandName: string;          // required
  brandDescription: string;   // required, free text
  officialDomains: string[];  // user can add multiple
  socialHandles: string[];    // optional
}
```

---

## Prompt examples (for testing)

### Example 1: clean positive organic result

**Input block:**
```json
{
  "blockType": "organic",
  "position": 1,
  "text": "Example — HR Analytics for Modern Teams. Join 200+ companies measuring engagement, retention, and team health with our platform. Free trial available.",
  "sourceDomain": "example.com",
  "sourceUrl": "https://example.com/",
  "sourceTitle": "Example — HR Analytics for Modern Teams"
}
```

**Expected output (with brand = "example.com"):**
```json
{
  "sentiment": "positive",
  "brandVisibility": "title",
  "relevance": "on-topic",
  "risk": { "flag": false, "reasons": [] },
  "ownership": "owned",
  "oneLineSummary": "Official site positioning Example as HR analytics for modern teams."
}
```

### Example 2: risky third-party comparison

**Input block:**
```json
{
  "blockType": "organic",
  "position": 4,
  "text": "Top 10 Example Alternatives in 2026. Looking for a better fit? We compared the leading HR analytics tools so you don't have to.",
  "sourceDomain": "g2.com",
  "sourceUrl": "https://g2.com/categories/hr-analytics/alternatives",
  "sourceTitle": "Top 10 Example Alternatives in 2026"
}
```

**Expected output:**
```json
{
  "sentiment": "negative",
  "brandVisibility": "title",
  "relevance": "on-topic",
  "risk": { "flag": true, "reasons": ["positions brand as something to be replaced", "prominent ranking (position 4)"] },
  "ownership": "third-party",
  "oneLineSummary": "G2 alternatives listing positions Example as a brand users might want to switch from."
}
```

### Example 3: People Also Ask with risky question

**Input block:**
```json
{
  "blockType": "people-also-ask",
  "position": 6,
  "text": "Is Example legitimate?",
  "sourceDomain": "trustpilot.com",
  "sourceUrl": "https://trustpilot.com/review/example.com",
  "sourceTitle": "Example Reviews | Read Customer Reviews"
}
```

**Expected output:**
```json
{
  "sentiment": "negative",
  "brandVisibility": "title",
  "relevance": "on-topic",
  "risk": { "flag": true, "reasons": ["question implies doubt about legitimacy", "PAA questions seed reader concerns"] },
  "ownership": "third-party",
  "oneLineSummary": "PAA surfaces a legitimacy question that creates doubt for prospects."
}
```

### Example 4: off-topic namesake collision

**Input block:**
```json
{
  "blockType": "organic",
  "position": 7,
  "text": "Example (noun): something that is typical of the group of things that it is a member of. Cambridge English Dictionary definition with examples.",
  "sourceDomain": "dictionary.cambridge.org",
  "sourceUrl": "https://dictionary.cambridge.org/dictionary/english/example",
  "sourceTitle": "EXAMPLE | English meaning - Cambridge Dictionary"
}
```

**Expected output:**
```json
{
  "sentiment": "neutral",
  "brandVisibility": "none",
  "relevance": "off-topic",
  "risk": { "flag": false, "reasons": [] },
  "ownership": "third-party",
  "oneLineSummary": "Dictionary definition of the noun 'example', not related to the brand."
}
```

---

## Implementation notes for the developer

### Truncation

Truncate each block's `text` to 500 characters before sending to the model. Long Wikipedia summaries or long article snippets blow the context window for no benefit — the first 500 chars are enough to judge sentiment.

### Batching

- Default batch size: 4 blocks per prompt.
- If a batch fails with `QuotaExceededError`, halve and retry.
- Run batches sequentially, not in parallel. Gemini Nano does not parallelize well, and parallel runs would compete for the same model resources.

### Validation

After each batch response, validate:

```js
function validateBatchResponse(response, expectedLength) {
  if (!Array.isArray(response)) return false;
  if (response.length !== expectedLength) return false;
  for (const item of response) {
    if (!['positive', 'neutral', 'mixed', 'negative'].includes(item.sentiment)) return false;
    // ... etc
  }
  return true;
}
```

If validation fails, mark the batch as failed (don't retry — the model is being inconsistent and retrying usually doesn't help with small models).

### Determinism

`temperature` and `topK` are not exposed for the standard web Prompt API (only for the Chrome Extensions trial variant). If exposed in the user's environment, set `temperature: 0.3` and `topK: 1` for more deterministic classification. If not exposed, accept that two runs of the same SERP might differ slightly — document this in the README.

### Token accounting

Before sending each batch, estimate tokens (rough rule: 1 token ≈ 4 chars for English). If estimated input + expected output > 50% of `session.contextWindow`, split the batch.

---

## What NOT to ask the model to do

Things that look tempting but should be deterministic logic, not model output:

- **Domain matching for ownership** — string compare in code. The model can hint, but the analyzer makes the call.
- **Score calculation** — pure formula in code. Never ask the model to compute the score.
- **Position weighting** — pure formula in code.
- **Risk aggregation** — collect risk flags from per-block analysis; don't ask the model for a "top 3 risks" pass. The model already flagged them.

The model's job is local classification. The analyzer's job is global aggregation. Keep them separate — it makes failures easier to debug and the score auditable.
