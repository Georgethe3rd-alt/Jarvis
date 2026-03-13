/**
 * URL Fetching module for Jarvis
 * Fetches web pages and extracts readable content
 */
const https = require('https');
const http = require('http');

/**
 * Fetch a URL and extract readable text content
 */
async function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    
    client.get(url, { 
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JarvisBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl).then(resolve);
      }
      
      if (res.statusCode !== 200) {
        return resolve({ error: `HTTP ${res.statusCode}` });
      }
      
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        // Cap at 500KB
        if (data.length > 500000) {
          res.destroy();
        }
      });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        
        if (contentType.includes('application/json')) {
          try {
            const json = JSON.parse(data);
            resolve({ content: JSON.stringify(json, null, 2).substring(0, 8000), type: 'json' });
          } catch (e) {
            resolve({ content: data.substring(0, 8000), type: 'text' });
          }
          return;
        }
        
        // Extract readable text from HTML
        const text = htmlToText(data);
        resolve({ content: text.substring(0, 8000), type: 'html', title: extractTitle(data) });
      });
    }).on('error', (e) => {
      resolve({ error: e.message });
    }).on('timeout', () => {
      resolve({ error: 'Request timed out' });
    });
  });
}

/**
 * Basic HTML to text conversion
 */
function htmlToText(html) {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  
  // Convert common elements
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n## $1\n');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '\n• $1');
  text = text.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '\n> $1\n');
  
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  
  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.trim();
  
  return text;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : null;
}

module.exports = { fetchUrl };
