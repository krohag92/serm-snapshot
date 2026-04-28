// content/extractors/organic.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  runExtractor,
} from '../utils.js';

export const blockType = 'organic';

// A "result container" is the closest ancestor that bounds one organic result.
// Modern Google uses several wrappers; we walk up to the first that fits.
function findResultContainer(node) {
  let cur = node;
  while (cur && cur.nodeType === 1) {
    if (cur.matches?.('div.MjjYud, div.g, div[data-hveid][data-snc], div[data-hveid].N54PNb, div[data-hveid]')) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function extractSnippet(container) {
  return safeText(
    container?.querySelector('[data-sncf]') ||
      container?.querySelector('.VwiC3b') ||
      container?.querySelector('.lEBKkf') ||
      container?.querySelector('div[style*="webkit-line-clamp"]') ||
      container?.querySelector('span.HiHjCd') ||
      null
  );
}

function hasRich(container) {
  if (!container) return false;
  return (
    !!container.querySelector('g-review-stars') ||
    !!container.querySelector('[aria-label*="Rated" i]') ||
    !!container.querySelector('table.AaVjTc') ||
    !!container.querySelector('div[role="navigation"] a[href]')
  );
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const root = doc.getElementById('search') || doc;

    // Anchor on every <h3> inside results — this is the most stable signal for an
    // organic title across modern Google layouts. Walk up to find the link and the
    // result container.
    const headings = Array.from(root.querySelectorAll('h3'));

    const seenContainers = new Set();
    const seenUrls = new Set();
    const data = [];
    let position = 0;

    for (const h3 of headings) {
      const linkEl = h3.closest('a[href]');
      if (!linkEl) continue;

      const href = absUrl(linkEl.getAttribute('href'));
      if (!href || href.startsWith('javascript:')) continue;
      if (href.includes('google.com/search')) continue;
      if (href.includes('/imgres?')) continue;
      if (seenUrls.has(href)) continue;

      const container = findResultContainer(linkEl);
      if (!container) continue;
      if (seenContainers.has(container)) continue;

      // Skip results that are inside a known feature container (AIO, KP, FS, PAA,
      // Top stories, Discussions and forums, Videos). Those are surfaced by
      // their own extractors.
      const inFeature =
        container.closest(
          '[data-attrid*="GenerativeAI"], div[data-subtree="aio"], .kp-wholepage, .knowledge-panel, [data-attrid*="kc:/"], .xpdopen, #paa-wholepage'
        ) ||
        // PAA item ancestor
        linkEl.closest('div[jsname="N760b"], .related-question-pair, [data-q]') ||
        // Top stories / video / discussions sections
        (() => {
          const section = container.closest('g-section-with-header');
          if (!section) return null;
          const heading = safeText(section.querySelector('h2, h3, [role="heading"]'));
          if (/top stories|news|videos|discussions? and forums/i.test(heading)) return section;
          return null;
        })();
      if (inFeature) continue;

      const title = safeText(h3);
      if (!title) continue;

      seenContainers.add(container);
      seenUrls.add(href);
      position += 1;
      if (position > 10) break;

      const snippet = extractSnippet(container);
      const text = [title, snippet].filter(Boolean).join(' — ');

      data.push({
        blockType,
        position,
        text: truncate(text),
        sourceUrl: href,
        sourceTitle: title,
        sourceDomain: domainFromUrl(href),
        hasRichSnippet: hasRich(container),
        _yPos: container.getBoundingClientRect?.().top ?? 0,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
