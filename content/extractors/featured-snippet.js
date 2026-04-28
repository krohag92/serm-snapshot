// content/extractors/featured-snippet.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  positionOf,
  getOrderedResultContainers,
  runExtractor,
} from '../utils.js';

export const blockType = 'featured-snippet';

// Locate the FS snippet text element first — that's the most stable marker —
// then walk up to the wrapper that also holds the source link (h3 + anchor).
function findSnippetEl(doc) {
  return (
    doc.querySelector('#search .LGOjhe') ||
    doc.querySelector('#search [data-attrid="wa:/description"]') ||
    doc.querySelector('#search .ifM9O') ||
    null
  );
}

function findContainer(snippetEl) {
  // Widest result-scoped wrapper first — modern Google nests hveid containers,
  // and the FS source link can live as a sibling of the inner snippet block.
  // `div.MjjYud` is the outer per-result card class on current SERPs.
  return (
    snippetEl.closest('div.MjjYud') ||
    snippetEl.closest('div[data-hveid]') ||
    snippetEl.closest('.kp-blk') ||
    snippetEl.closest('.xpdopen') ||
    snippetEl.closest('block-component') ||
    snippetEl.parentElement ||
    snippetEl
  );
}

// When no clickable <a> can be found, the cite element typically still shows
// the source domain as plain text. Returning that domain lets ownership
// detection (which matches by domain, not URL) classify owned FS correctly.
function fallbackDomainFromCite(container) {
  const cite =
    container.querySelector('cite') ||
    container.querySelector('.iUh30, .qzEoUe, .tjvcx, .UPmit, .PZPZlf');
  if (!cite) return '';
  const text = (cite.innerText || cite.textContent || '').trim();
  const m = text.match(/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function isUsefulHref(href) {
  if (!href) return false;
  if (href.startsWith('javascript:')) return false;
  if (href.startsWith('#') && !href.startsWith('#:~:text=')) return false;
  if (href === '/' || href === '') return false;
  if (href.includes('google.com/search')) return false;
  if (href.includes('/preferences')) return false;
  if (href.includes('/aclk?')) return false;        // ad redirect
  if (href.includes('webcache.googleusercontent')) return false;
  return true;
}

function findSourceLink(container) {
  // Strategy 1: the title h3 link (most reliable when present).
  const h3 = container.querySelector('h3');
  if (h3) {
    const a = h3.closest('a[href]');
    if (a && isUsefulHref(a.getAttribute('href'))) return a;
  }
  // Strategy 2: known FS-source link classes.
  const named = [
    'a.sXtWJb',
    '.yuRUbf > a',
    'a[data-ved][href^="http"]',
  ];
  for (const sel of named) {
    const a = container.querySelector(sel);
    if (a && isUsefulHref(a.getAttribute('href'))) return a;
  }
  // Strategy 3: first external-looking link in the container.
  const all = container.querySelectorAll('a[href]');
  for (const a of all) {
    const href = a.getAttribute('href') || '';
    if (!isUsefulHref(href)) continue;
    if (!/^https?:/i.test(href)) continue;
    return a;
  }
  return null;
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const ordered = getOrderedResultContainers();

    const snippetEl = findSnippetEl(doc);
    if (!snippetEl) return { found: false, data: [] };

    const container = findContainer(snippetEl);

    // Skip if this snippet actually lives inside a knowledge panel — KP has
    // its own extractor and we don't want to double-count.
    if (container.closest('.kp-wholepage, .knowledge-panel')) {
      return { found: false, data: [] };
    }

    const snippetText = safeText(snippetEl);
    if (!snippetText) return { found: false, data: [] };

    const linkEl = findSourceLink(container);
    const sourceUrl = absUrl(linkEl?.getAttribute('href'));
    let sourceDomain = sourceUrl ? domainFromUrl(sourceUrl) : '';
    if (!sourceDomain) sourceDomain = fallbackDomainFromCite(container);

    const sourceTitle =
      safeText(linkEl?.querySelector('h3')) ||
      safeText(container.querySelector('h3')) ||
      safeText(linkEl);

    const position = positionOf(container, ordered) || 1;

    return {
      found: true,
      data: [
        {
          blockType,
          position,
          text: truncate(snippetText),
          sourceUrl: sourceUrl || undefined,
          sourceTitle: sourceTitle || undefined,
          sourceDomain: sourceDomain || undefined,
          _yPos: container.getBoundingClientRect?.().top ?? 0,
        },
      ],
    };
  });
}
