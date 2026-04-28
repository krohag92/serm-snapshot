// content/extractors/knowledge-panel.js
import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  pickFirst,
  positionOf,
  getOrderedResultContainers,
  runExtractor,
} from '../utils.js';

export const blockType = 'knowledge-panel';

const SELECTORS = [
  'div[data-attrid="kc:/business/business"]',
  '.kp-wholepage',
  '.knowledge-panel',
  '#kp-wp-tab-cont-overview',
  'g-tray-header + div',
];

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    const ordered = getOrderedResultContainers();
    const container = pickFirst(doc, SELECTORS);
    if (!container) return { found: false, data: [] };

    const titleEl =
      container.querySelector('[data-attrid="title"]') ||
      container.querySelector('h2') ||
      container.querySelector('[role="heading"]');
    const subtitleEl =
      container.querySelector('[data-attrid="subtitle"]') ||
      container.querySelector('.wwUB2c') ||
      container.querySelector('[data-attrid*="kc:/"][data-attrid*=":subtitle"]');

    const title = safeText(titleEl);
    const subtitle = safeText(subtitleEl);

    const description = safeText(
      container.querySelector('[data-attrid*="description"]') ||
        container.querySelector('.kno-rdesc') ||
        container
    );

    const links = Array.from(container.querySelectorAll('a[href]'))
      .map((a) => absUrl(a.getAttribute('href')))
      .filter((href) => href && !href.startsWith('javascript:') && !href.includes('google.com/search'));

    const seen = new Set();
    const citedDomains = [];
    for (const href of links) {
      const d = domainFromUrl(href);
      if (d && !seen.has(d)) {
        seen.add(d);
        citedDomains.push(d);
      }
    }

    const text = [title, subtitle, description].filter(Boolean).join(' — ');
    if (!text) return { found: false, data: [] };

    const position = positionOf(container, ordered) || 1;

    return {
      found: true,
      data: [
        {
          blockType,
          position,
          text: truncate(text),
          sourceTitle: title || undefined,
          sourceUrl: links[0] || undefined,
          sourceDomain: links[0] ? domainFromUrl(links[0]) : undefined,
          citedDomains,
          citedUrls: links,
          _yPos: container.getBoundingClientRect?.().top ?? 0,
        },
      ],
    };
  });
}
