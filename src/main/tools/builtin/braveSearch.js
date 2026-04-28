/**
 * Built-in Brave Search tool - wraps BraveSearchService as a tool
 * Can be used when MCP Brave Search server is not available
 */

const BraveSearchService = require('../../services/BraveSearchService');

const declaration = {
  name: 'brave_web_search',
  description: 'Search the web for current information, news, and general knowledge. Use this when the user asks about recent events, needs to look something up, or wants information that may have changed.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up on the web'
      }
    },
    required: ['query']
  }
};

async function handler(args) {
  const { query } = args;
  if (!query) {
    throw new Error('Search query is required');
  }

  const results = await BraveSearchService.search(query);

  if (!results.web?.results?.length) {
    return 'No search results found.';
  }

  return results.web.results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description || 'No description'}`)
    .join('\n\n');
}

module.exports = { declaration, handler };
