// lib/exporters.js — render the report as Markdown / JSON / CSV.

const SENTIMENT_EMOJI = {
  positive: '🟢',
  neutral: '🟡',
  negative: '🔴',
  mixed: '⚫',
};

function isoDate(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function blockTypeLabel(type) {
  return type
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function blockHeading(b) {
  if (b.blockType === 'organic') {
    return `Position #${b.position}: ${b.sourceDomain || 'unknown'} (${b.sentiment}, ${b.ownership})`;
  }
  return `${blockTypeLabel(b.blockType)} (${b.sentiment}, ${b.ownership})`;
}

export function toMarkdown(report) {
  const brand = report.brandContext?.brandName || '(brand)';
  const date = isoDate(report.timestamp);
  const lines = [];
  lines.push(`# SERM Snapshot — ${brand} — ${date}`);
  lines.push('');
  lines.push(`**Query:** "${report.query || ''}"`);
  lines.push(`**Reputation Score:** ${report.score}/100`);
  lines.push('');
  lines.push('## Sentiment Breakdown');
  const s = report.sentiment.counts;
  const p = report.sentiment.percentages;
  lines.push(`- 🟢 Positive: ${s.positive} (${p.positive}%)`);
  lines.push(`- 🟡 Neutral: ${s.neutral} (${p.neutral}%)`);
  lines.push(`- 🔴 Negative: ${s.negative} (${p.negative}%)`);
  lines.push(`- ⚫ Mixed: ${s.mixed} (${p.mixed}%)`);
  lines.push('');

  lines.push('## Top Risks');
  if (!report.risks.length) {
    lines.push('_No flagged risks._');
  } else {
    report.risks.forEach((r, i) => {
      const reasons = (r.risk?.reasons || []).join('; ');
      lines.push(
        `${i + 1}. **${blockHeading(r)}** — ${r.oneLineSummary}${reasons ? ` _(${reasons})_` : ''}`
      );
    });
  }
  lines.push('');

  lines.push('## Block-by-block');
  lines.push('');
  for (const b of report.blocks) {
    lines.push(`### ${blockHeading(b)}`);
    if (b.sourceUrl) lines.push(`> Source: ${b.sourceUrl}`);
    if (b.sourceTitle) lines.push(`> Title: ${b.sourceTitle}`);
    lines.push(`> ${b.oneLineSummary}`);
    if (b.risk?.flag && b.risk.reasons?.length) {
      lines.push(`> Risk: ${b.risk.reasons.join('; ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function toJSON(report) {
  return JSON.stringify(report, null, 2);
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  if (/[",\n\r]/.test(s)) return `"${s}"`;
  return s;
}

export function toCSV(report) {
  const headers = [
    'position',
    'blockType',
    'domain',
    'url',
    'title',
    'sentiment',
    'brandVisibility',
    'ownership',
    'riskFlag',
    'summary',
  ];
  const rows = [headers.join(',')];
  for (const b of report.blocks) {
    rows.push(
      [
        csvCell(b.position),
        csvCell(b.blockType),
        csvCell(b.sourceDomain || ''),
        csvCell(b.sourceUrl || ''),
        csvCell(b.sourceTitle || ''),
        csvCell(b.sentiment),
        csvCell(b.brandVisibility),
        csvCell(b.ownership),
        csvCell(b.risk?.flag ? 'true' : 'false'),
        csvCell(b.oneLineSummary || ''),
      ].join(',')
    );
  }
  return rows.join('\n');
}

export function filenameFor(report, ext) {
  const brand = (report.brandContext?.brandName || 'snapshot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'snapshot';
  return `serm-snapshot-${brand}-${isoDate(report.timestamp)}.${ext}`;
}

export const EMOJI = SENTIMENT_EMOJI;
