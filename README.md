# SERM Snapshot

> Free, private, instant SERP reputation snapshots — powered by Chrome's local Gemini Nano.

A Chrome extension that analyzes a Google search results page on a branded query and produces a one-screen reputation snapshot: sentiment per block, ownership breakdown, top risks, and a Reputation Score. **All AI runs locally** — no API keys, no subscriptions, no data leaving your device.

Built for SEO/SERM specialists who don't want to pay $50–200/month for a tool they use a few times a week.

---

## What it does

When you open a Google SERP for a branded query and click the extension, it:

1. Extracts every visible block on the page — AI Overview, knowledge panel, featured snippet, People Also Ask, organic top 10, and Twitter/Reddit/news/video carousels.
2. Sends each block to Chrome's built-in Gemini Nano (locally, on your machine) to classify sentiment, brand visibility, risk, and ownership.
3. Aggregates everything into a side-panel report with a Reputation Score, sentiment breakdown, top risks, and per-block analysis.
4. Lets you export the snapshot as Markdown, JSON, or CSV.

Typical run on a 10-block SERP takes 15–30 seconds.

---

## Why local AI matters here

Reputation analysis often involves client names, internal context, or sensitive comparisons you'd rather not pipe to a third-party API. With Chrome's built-in Prompt API, the model runs entirely on the user's device — no data is sent anywhere.

The flip side: Gemini Nano is small, so this tool focuses on classification (a task it does well), not synthesis or recommendations (which need a bigger model).

---

## Hardware & browser requirements

This extension uses Chrome's [Built-in Prompt API](https://developer.chrome.com/docs/ai/prompt-api), which has hard requirements:

- **Browser:** Chrome 138 or newer, on desktop only
- **OS:** Windows 10/11, macOS 13+, Linux, or ChromeOS on Chromebook Plus
- **Disk:** 22 GB free on the volume containing your Chrome profile (Gemini Nano takes ~2 GB; Chrome reserves overhead)
- **Hardware:** GPU with > 4 GB VRAM, or CPU with 16 GB+ RAM and 4+ cores
- **Network:** unmetered connection (only for the one-time model download)

To check whether your machine is eligible, open `chrome://on-device-internals` in Chrome.

If your setup doesn't meet the requirements, the extension will tell you exactly what's missing instead of failing silently.

---

## Installation (for now: dev mode only)

The extension is not yet on the Chrome Web Store. To try it:

1. Clone this repo:
   ```bash
   git clone https://github.com/krohag92/serm-snapshot.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the cloned folder.
5. Pin the extension icon for easy access.

The first time you run an analysis, Chrome will download the Gemini Nano model (~2 GB). This happens once.

---

## Usage

1. Search Google for a branded query — e.g., your client's name.
2. Click the SERM Snapshot icon in the toolbar; the side panel opens.
3. On first use for a brand, fill in:
   - Brand name
   - One-sentence description (e.g., "B2B HR analytics SaaS")
   - Official domains (one per line)
   - Optional: official social handles
4. Click **Analyze SERP**.
5. Review the report; export if needed.

The brand context is saved locally so you don't re-enter it for the same client.

### Bulk mode

If you want to analyze a list of branded queries in one go, click **Bulk mode →** in the panel header:

1. Paste your queries — one per line.
2. Click **Run bulk**.
3. Each query opens in a background tab, gets extracted + analyzed, then the tab closes. Progress shows the current query and stage.
4. When it finishes, all reports are saved to history. Export everything as combined JSON or CSV.

Bulk runs sequentially — Gemini Nano can't parallelize — so expect ~30 seconds per query. Keep the side panel open; closing it cancels the run. Cancel anytime; reports completed before you cancel are kept.

---

## What the score means

The **Reputation Score** (0–100) is a directional signal, not a precise metric. It weighs each block by sentiment, ownership, and screen position (top blocks count more). A higher score means the SERP is more favorable to the brand.

Don't treat it like a Google PageSpeed score. It's a number that helps you compare *the same brand over time*, or *one brand against another with the same context*. Cross-brand comparisons are noisy because branded SERPs differ structurally.

The exact formula is in `lib/analyzer.js` and is intentionally simple so you can read it.

---

## Privacy

- Page content is processed in your browser and sent only to Gemini Nano (which runs on your machine).
- Brand context, settings, and snapshot history are stored in `chrome.storage.local` — never synced, never uploaded.
- No telemetry. No analytics. No external requests beyond Google itself (the page you're analyzing) and Chrome's own model download.

---

## Known limitations

- **Google's DOM changes constantly.** When extractors break, results will be incomplete. PRs welcome (see `content/extractors/` — each extractor is one file).
- **Sentiment on very short snippets is imperfect.** "Best alternative to X" is genuinely ambiguous. Treat the score as directional.
- **Desktop Chrome only.** The Prompt API doesn't run on mobile or non-Chromium browsers.
- **Localized SERPs.** Tested on `google.com` (US English layout). Country-specific TLDs may have different DOM structures.
- **First run requires a ~2 GB model download** over an unmetered connection.
- **Re-runs may differ slightly.** Small models aren't fully deterministic; expect minor variation across runs.

---

## Contributing

This is an experimental open-source tool. Most likely things to contribute:

- **Fix a broken extractor** — when Google changes a selector, the relevant file in `content/extractors/` needs an update. Each extractor is self-contained and < 100 lines.
- **Add an extractor** — for a SERP block type not yet covered.
- **Improve the prompt** — test cases that the current prompts misclassify are valuable. Open an issue with input + expected vs actual.
- **Localization** — extractors for `google.de`, `google.co.uk`, etc.

PRs should keep the no-build-step, no-framework discipline. Vanilla JS only.

---

## Project structure

```
serm-snapshot/
├── manifest.json
├── background.js
├── content/
│   ├── content.js                  # extraction orchestrator
│   ├── extractors/                 # one file per SERP block type
│   └── utils.js
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js
├── lib/
│   ├── prompt-runner.js            # Prompt API wrapper
│   ├── analyzer.js                 # aggregation + score
│   ├── exporters.js
│   └── messages.js
├── prompts/
│   ├── system.js                   # system prompt
│   └── schemas.js                  # JSON Schemas
└── icons/
```

See `SPEC.md` and `PROMPTS.md` for full implementation details.

---

## Why this exists

I work in SERM and AI visibility. Existing tools that monitor branded search results well are powerful but pricey, and most of them send your queries through a vendor's pipeline. Chrome quietly shipped a local AI model that can handle classification just fine — so I built the smallest possible tool to prove the point.

If you're an SEO or marketer working on reputation, try it on one of your client's branded queries and see what comes back. Issues, ideas, and broken-extractor reports are all welcome.

— [Anton](https://antonkrokhmal.com/)

---

## License

MIT. Use it, fork it, modify it, ship it. No warranties.
