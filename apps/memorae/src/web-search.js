/**
 * Web Search module for Jarvis
 * Uses Perplexity API (sonar model) for high-quality search results
 * Falls back to DuckDuckGo HTML scraping if no API key
 */
const https = require('https');
const { getConfig } = require('./whatsapp');

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Search using Perplexity API (sonar model)
 */
async function perplexitySearch(query, apiKey) {
  const response = await httpRequest('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: 'You are a helpful search assistant. Provide concise, factual answers with sources when available.' },
        { role: 'user', content: query }
      ],
      max_tokens: 1024,
    }),
  });

  const data = JSON.parse(response.body);
  if (data.choices && data.choices[0]) {
    const answer = data.choices[0].message.content;
    const citations = data.citations || [];
    let result = answer;
    if (citations.length > 0) {
      result += '\n\nSources:\n' + citations.slice(0, 5).map((c, i) => `${i + 1}. ${c}`).join('\n');
    }
    return { results: result, source: 'perplexity' };
  }
  throw new Error('No results from Perplexity');
}

/**
 * Search using Brave Search API
 */
async function braveSearch(query, apiKey) {
  const response = await httpRequest(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
    {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    }
  );

  const data = JSON.parse(response.body);
  if (data.web && data.web.results) {
    const results = data.web.results.slice(0, 5).map((r, i) =>
      `${i + 1}. **${r.title}**\n${r.description}\n${r.url}`
    ).join('\n\n');
    return { results, source: 'brave' };
  }
  throw new Error('No results from Brave');
}

/**
 * Fallback: DuckDuckGo HTML scraping
 */
async function duckDuckGoSearch(query) {
  const response = await httpRequest(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const snippets = [];
  const titleMatches = response.body.match(/<a rel="nofollow" class="result__a"[^>]*>(.*?)<\/a>/g) || [];
  const snippetMatches = response.body.match(/<a class="result__snippet"[^>]*>(.*?)<\/a>/g) || [];
  const urlMatches = response.body.match(/<a rel="nofollow" class="result__url"[^>]*>(.*?)<\/a>/g) || [];

  for (let i = 0; i < Math.min(titleMatches.length, 5); i++) {
    const title = (titleMatches[i] || '').replace(/<[^>]+>/g, '').trim();
    const snippet = (snippetMatches[i] || '').replace(/<[^>]+>/g, '').trim();
    const url = (urlMatches[i] || '').replace(/<[^>]+>/g, '').trim();
    if (title || snippet) {
      snippets.push(`${i + 1}. **${title}**\n${snippet}${url ? '\n' + url : ''}`);
    }
  }

  if (snippets.length > 0) {
    return { results: snippets.join('\n\n'), source: 'duckduckgo' };
  }
  return { results: 'No results found.', source: 'duckduckgo' };
}

/**
 * Main search function — tries APIs in order, falls back gracefully
 */
async function webSearch(query) {
  try {
    // Try Perplexity first (best quality)
    const perplexityKey = getConfig('perplexity_api_key') || process.env.PERPLEXITY_API_KEY;
    if (perplexityKey) {
      try {
        return await perplexitySearch(query, perplexityKey);
      } catch (e) {
        console.warn('[SEARCH] Perplexity failed:', e.message);
      }
    }

    // Try Brave
    const braveKey = getConfig('brave_api_key') || process.env.BRAVE_API_KEY;
    if (braveKey) {
      try {
        return await braveSearch(query, braveKey);
      } catch (e) {
        console.warn('[SEARCH] Brave failed:', e.message);
      }
    }

    // Fallback to DuckDuckGo
    return await duckDuckGoSearch(query);
  } catch (err) {
    console.error('[SEARCH] All search methods failed:', err.message);
    return { error: 'Search failed: ' + err.message };
  }
}

module.exports = { webSearch };
