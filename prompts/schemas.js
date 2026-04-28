// prompts/schemas.js — JSON Schema for structured output from the model.

export const batchAnalysisSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'mixed', 'negative'],
      },
      brandVisibility: {
        type: 'string',
        enum: ['title', 'snippet', 'url-only', 'none'],
      },
      relevance: {
        type: 'string',
        enum: ['on-topic', 'tangential', 'off-topic'],
      },
      risk: {
        type: 'object',
        properties: {
          flag: { type: 'boolean' },
          reasons: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['flag', 'reasons'],
      },
      ownership: {
        type: 'string',
        enum: ['owned', 'earned', 'third-party'],
      },
      oneLineSummary: {
        type: 'string',
      },
    },
    required: [
      'sentiment',
      'brandVisibility',
      'relevance',
      'risk',
      'ownership',
      'oneLineSummary',
    ],
  },
};

const SENTIMENTS = ['positive', 'neutral', 'mixed', 'negative'];
const VISIBILITIES = ['title', 'snippet', 'url-only', 'none'];
const RELEVANCES = ['on-topic', 'tangential', 'off-topic'];
const OWNERSHIPS = ['owned', 'earned', 'third-party'];

export function validateBatchResponse(response, expectedLength) {
  if (!Array.isArray(response)) return false;
  if (response.length !== expectedLength) return false;
  for (const item of response) {
    if (!item || typeof item !== 'object') return false;
    if (!SENTIMENTS.includes(item.sentiment)) return false;
    if (!VISIBILITIES.includes(item.brandVisibility)) return false;
    if (!RELEVANCES.includes(item.relevance)) return false;
    if (!OWNERSHIPS.includes(item.ownership)) return false;
    if (!item.risk || typeof item.risk !== 'object') return false;
    if (typeof item.risk.flag !== 'boolean') return false;
    if (!Array.isArray(item.risk.reasons)) return false;
    if (typeof item.oneLineSummary !== 'string') return false;
  }
  return true;
}
