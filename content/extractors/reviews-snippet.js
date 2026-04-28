// content/extractors/reviews-snippet.js
//
// Detects organic results that surface a rating signal. We accept either:
//   - explicit microdata (g-review-stars, aria-label="Rated …")
//   - rating shown via icon + numeric in nearby spans
//   - a fallback text pattern in the snippet ("4-star rating", "4.6/5", etc.)

import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  runExtractor,
} from '../utils.js';

export const blockType = 'reviews-snippet';

const RATING_RE = /(\d(?:[.,]\d)?)\s*(?:\/\s*5|out of\s*5|stars?|★|-?\s*star)/i;
const COUNT_RE = /([\d.,]+)\s*(?:reviews?|votes?|ratings?|customer reviews?)/i;

function findRatingNode(node) {
  return (
    node.querySelector('g-review-stars') ||
    node.querySelector('[aria-label*="Rated" i]') ||
    node.querySelector('[aria-label*="rating" i]') ||
    node.querySelector('[aria-label*="stars" i]') ||
    node.querySelector('span.yi40Hd, span.KMdzJ, span.oqSTJd, .Aq14fc') ||
    null
  );
}

function parseRating(text) {
  if (!text) return null;
  const m = text.match(RATING_RE);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 5) return null;
  return v;
}

function parseCount(text) {
  if (!text) return null;
  const m = text.match(COUNT_RE);
  if (!m) return null;
  return parseInt(m[1].replace(/[.,]/g, ''), 10) || null;
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const root = doc.getElementById('search') || doc;
    const headings = Array.from(root.querySelectorAll('h3'));

    const data = [];
    let position = 0;
    const seenUrls = new Set();

    for (const h3 of headings) {
      const linkEl = h3.closest('a[href]');
      if (!linkEl) continue;
      const href = absUrl(linkEl.getAttribute('href'));
      if (!href || seenUrls.has(href) || href.includes('google.com/search')) continue;

      const node =
        h3.closest('div.MjjYud') ||
        h3.closest('div[data-hveid]') ||
        h3.parentElement;
      if (!node) continue;

      seenUrls.add(href);
      position += 1;
      if (position > 10) break;

      const ratingNode = findRatingNode(node);
      const nodeText = safeText(node);

      // 1) Try the explicit rating widget.
      let rating = null;
      if (ratingNode) {
        const aria = ratingNode.getAttribute?.('aria-label') || '';
        rating = parseRating(aria) ?? parseRating(safeText(ratingNode));
      }
      // 2) Fallback: search the snippet text for a rating mention.
      if (rating == null) rating = parseRating(nodeText);
      // 3) If no rating signal at all, this isn't a reviews result — skip.
      if (rating == null) continue;

      const reviewCount = parseCount(nodeText);
      const title = safeText(h3);
      const text = `${title || ''} — Rating ${rating}${
        reviewCount != null ? `, ${reviewCount} reviews` : ''
      }`;

      data.push({
        blockType,
        position,
        text: truncate(text),
        sourceUrl: href,
        sourceTitle: title || undefined,
        sourceDomain: domainFromUrl(href),
        rating,
        reviewCount,
        ratingSource: domainFromUrl(href),
        _yPos: node.getBoundingClientRect?.().top ?? 0,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
