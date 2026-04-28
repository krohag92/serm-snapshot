// content/extractors/video-carousel.js
//
// Treats one video as one block. Chapter timestamps (`&t=...`) and text
// fragments are folded into the parent video, not counted as separate items.

import {
  safeText,
  truncate,
  domainFromUrl,
  absUrl,
  runExtractor,
} from '../utils.js';

export const blockType = 'video-carousel';

const VIDEO_RE = /(?:^|\.)((?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com))$/i;

function canonicalVideoKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `youtube:${v}`;
      // shorts: /shorts/<id>
      const m = u.pathname.match(/\/shorts\/([^/]+)/);
      if (m) return `youtube:${m[1]}`;
      return `${host}:${u.pathname}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return `youtube:${id}`;
    }
    if (host === 'vimeo.com') {
      return `vimeo:${u.pathname}`;
    }
    if (host === 'tiktok.com') {
      return `tiktok:${u.pathname}`;
    }
    return host + u.pathname;
  } catch {
    return url;
  }
}

export function extract(doc = document) {
  return runExtractor(blockType, () => {
    // Find a top-level container with multiple distinct video pages.
    const candidates = doc.querySelectorAll('#search div[data-hveid], #search g-section-with-header');
    let container = null;
    let firstLinks = [];
    for (const c of candidates) {
      const links = Array.from(c.querySelectorAll('a[href]'));
      const videos = links.filter((a) => VIDEO_RE.test(domainFromUrl(absUrl(a.getAttribute('href')))));
      if (!videos.length) continue;

      // Count *distinct* canonical videos.
      const canonical = new Set();
      for (const a of videos) {
        const url = absUrl(a.getAttribute('href'));
        if (url.includes('#:~:text=')) continue;
        canonical.add(canonicalVideoKey(url));
      }
      if (canonical.size >= 2) {
        container = c;
        firstLinks = videos;
        break;
      }
    }

    if (!container) return { found: false, data: [] };

    const baseY = container.getBoundingClientRect?.().top ?? 0;

    const seen = new Set();
    const data = [];
    for (const a of firstLinks) {
      const url = absUrl(a.getAttribute('href'));
      if (!url) continue;
      if (url.includes('#:~:text=')) continue;
      const key = canonicalVideoKey(url);
      if (seen.has(key)) continue;
      seen.add(key);

      // Strip `&t=...` so we don't keep the timestamp variant as the canonical link.
      let cleanUrl = url;
      try {
        const u = new URL(url);
        u.searchParams.delete('t');
        u.hash = '';
        cleanUrl = u.toString();
      } catch { /* ignore */ }

      const card = a.closest('g-inner-card') || a.closest('div[data-hveid]') || a.closest('div');
      const title = safeText(
        card?.querySelector('div[role="heading"]') ||
          card?.querySelector('h3, h4') ||
          a.querySelector('h3') ||
          a
      );
      const channel = safeText(card?.querySelector('.pcJO7e, cite') || card?.querySelector('span'));
      const durationEl = card?.querySelector('.J1mWY, span[aria-label*="duration" i]');
      const duration = safeText(durationEl);

      const text = [title, channel, duration].filter(Boolean).join(' — ');
      if (!text) continue;

      data.push({
        blockType,
        position: 1,
        text: truncate(text),
        title: title || undefined,
        channel: channel || undefined,
        duration: duration || undefined,
        sourceUrl: cleanUrl,
        sourceDomain: domainFromUrl(cleanUrl),
        sourceTitle: title || undefined,
        _yPos: baseY,
      });
    }

    if (!data.length) return { found: false, data: [] };
    return { found: true, data };
  });
}
