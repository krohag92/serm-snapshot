// content/utils.js — shared DOM helpers used by the extractors.

export const MAX_BLOCK_TEXT = 500;

export function safeText(el) {
  if (!el) return '';
  const txt = el.innerText || el.textContent || '';
  return txt.replace(/\s+/g, ' ').trim();
}

export function truncate(text, max = MAX_BLOCK_TEXT) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

export function domainFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url, location.href);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function absUrl(url) {
  if (!url) return '';
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

// Returns DOM-order position of a node among a reference list of selected
// containers. Used to give every block a stable "position" on the page.
export function positionOf(node, ordered) {
  if (!node) return 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i] === node || ordered[i].contains(node)) return i + 1;
  }
  return 0;
}

// First match across a list of selectors. Each selector is tried in order.
export function pickFirst(root, selectors) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // bad selector, ignore
    }
  }
  return null;
}

export function pickAll(root, selectors) {
  for (const sel of selectors) {
    try {
      const els = root.querySelectorAll(sel);
      if (els && els.length) return Array.from(els);
    } catch {
      // bad selector, ignore
    }
  }
  return [];
}

// Wraps an extractor's main work. On any throw, logs and returns an empty result.
export function runExtractor(blockType, fn) {
  try {
    const result = fn();
    if (!result || typeof result !== 'object') {
      return { blockType, found: false, data: [] };
    }
    return {
      blockType,
      found: !!result.found && Array.isArray(result.data) && result.data.length > 0,
      data: Array.isArray(result.data) ? result.data : [],
    };
  } catch (err) {
    console.warn(`[serm-snapshot] extractor ${blockType} failed`, err);
    return { blockType, found: false, data: [] };
  }
}

// Generates DOM-ordered list of "result containers" we use as the position spine.
// Top-level organic and feature blocks live under #search.
export function getOrderedResultContainers() {
  const search = document.getElementById('search') || document;
  const candidates = search.querySelectorAll(
    '#search div[data-hveid], #rcnt div[data-hveid]'
  );
  return Array.from(candidates);
}

// Build a minimal "model block" from a raw extracted block.
export function toModelBlock(block) {
  return {
    blockType: block.blockType,
    position: block.position || 0,
    text: truncate(block.text || '', MAX_BLOCK_TEXT),
    ...(block.sourceDomain ? { sourceDomain: block.sourceDomain } : {}),
    ...(block.sourceUrl ? { sourceUrl: block.sourceUrl } : {}),
    ...(block.sourceTitle ? { sourceTitle: block.sourceTitle } : {}),
  };
}
