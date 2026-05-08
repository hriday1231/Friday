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

// Strip control characters and cap each field — search snippets are
// attacker-controlled (anyone with SEO access can write descriptions).
function _safeField(s, maxLen) {
  return String(s || '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ').slice(0, maxLen);
}

async function handler(args) {
  const { query } = args;
  if (!query) {
    throw new Error('Search query is required');
  }

  const results = await BraveSearchService.search(query);

  if (!results.web?.results?.length) {
    return 'No search results found.';
  }

  const total = results.web.results.length;
  const body = results.web.results
    .slice(0, 5)
    .map((r, i) =>
      `${i + 1}. ${_safeField(r.title, 200)}\n   URL: ${_safeField(r.url, 500)}\n   ${_safeField(r.description, 400) || 'No description'}`
    )
    .join('\n\n');

  // Wrap in untrusted_data so the model treats result text as data per the
  // trust-boundary clause in the system prompt.
  return `Showing ${Math.min(5, total)} of ${total} results for "${_safeField(query, 200)}":\n\n` +
    `<untrusted_data source="brave_web_search">\n${body}\n</untrusted_data>`;
}

module.exports = { declaration, handler };
