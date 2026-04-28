// content/extractors/news-carousel.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  positionOf,
  getOrderedResultContainers,
  runExtractor,
} from '../utils.js';

export const blockType = 'news-carousel';

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const ordered = getOrderedResultContainers();

    // The "Top stories" / news carousel typically lives in a g-section-with-header
    // with a "Top stories"/"News" heading.
    let container = null;
    const sections = doc.querySelectorAll(
      '#search g-section-with-header, #search div[data-hveid] g-section-with-header'
    );
    for (const s of sections) {
      const heading = safeText(s.querySelector('h2, h3, [role="heading"]'));
      if (/top stories|news|latest/i.test(heading)) {
        container = s;
        break;
      }
    }

    if (!container) return { found: false, data: [] };

    const position = positionOf(container, ordered) || 1;
    const baseY = container.getBoundingClientRect?.().top ?? 0;

    const cards = Array.from(
      container.querySelectorAll('g-inner-card, div[data-news-cluster-id], a[href][role="link"]')
    );

    const seen = new Set();
    const data = [];
    for (const card of cards) {
      const a = card.tagName === 'A' ? card : card.querySelector('a[href]');
      if (!a) continue;
      const url = absUrl(a.getAttribute('href'));
      if (!url || seen.has(url) || url.includes('google.com/search')) continue;
      seen.add(url);

      const headline = safeText(
        card.querySelector('div[role="heading"]') ||
          card.querySelector('h3, h4') ||
          card.querySelector('div[style*="webkit-line-clamp"]')
      );
      // publisher logos/names
      const publisher = safeText(
        card.querySelector('.MgUUmf, .CEMjEf') ||
          card.querySelector('cite') ||
          card.querySelector('span')
      );
      const dateEl = card.querySelector('span.OSrXXb, time, .ZE0LJd');
      const date = safeText(dateEl);

      const text = [headline, publisher, date].filter(Boolean).join(' — ');
      if (!text) continue;

      data.push({
        blockType,
        position,
        text: truncate(text),
        headline: headline || undefined,
        publisher: publisher || undefined,
        date: date || undefined,
        sourceUrl: url,
        sourceDomain: domainFromUrl(url),
        sourceTitle: headline || undefined,
        _yPos: baseY,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
