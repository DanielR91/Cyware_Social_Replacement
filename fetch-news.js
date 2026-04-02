import Parser from 'rss-parser';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import crypto from 'crypto';

// Initialize RSS Parser and Gemini Client
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let hasQuotaExceeded = false;
const QUOTA_PLACEHOLDER = "AI Summary Unavailable due to Gemini Rate Limit Hit - this will update upon rate reset";

// Helper for promise timeouts
function withTimeout(promise, ms, operationName) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Operation "${operationName}" timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// Helper to strip Markdown and parse JSON
function cleanAIResponse(text) {
  try {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse AI response as JSON:', text);
    throw e;
  }
}

// Helper for AI calls with automatic retry for 429s (Rate Limits)
async function callAIWithRetry(prompt, timeoutMs, operationName, retries = 3) {
  if (hasQuotaExceeded) throw new Error("QUOTA_EXCEEDED");
  
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      }), timeoutMs, operationName);
      return response;
    } catch (err) {
      const msg = err.message || "";
      // Only treat it as FATAL if it's a daily/budget limit. 
      if (msg.toLowerCase().includes("quota") && (msg.toLowerCase().includes("daily") || msg.toLowerCase().includes("rpd") || msg.toLowerCase().includes("budget"))) {
        console.error(`[FATAL] Daily Quota Exceeded. Switching to Headlines-Only mode.`);
        hasQuotaExceeded = true;
        throw new Error("QUOTA_EXCEEDED");
      }

      if ((msg.includes("429") || msg.includes("503")) && attempt < retries) {
        attempt++;
        const wait = 60000 * attempt; 
        console.warn(`[Retry Needed - ${msg.includes("429") ? "429" : "503"}] "${operationName}".`);
        console.warn(`Pausing for ${wait/1000}s... (Attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`AI Call Failed:`, JSON.stringify(err, null, 2));
        throw err;
      }
    }
  }
}

const SOURCES = [
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'CyberScoop', url: 'https://cyberscoop.com/feed/' },
  { name: 'The Register', url: 'https://www.theregister.com/security/headlines.atom' },
  { name: 'HackRead', url: 'https://hackread.com/feed/' },
  { name: 'The Record', url: 'https://therecord.media/feed' },
  { name: 'Dark Reading', url: 'https://www.darkreading.com/rss/all.xml' },
  { name: 'Security Affairs', url: 'https://securityaffairs.com/feed/' },
  { name: 'Unit 42', url: 'https://unit42.paloaltonetworks.com/feed/' },
  { name: 'Help Net Security', url: 'https://www.helpnetsecurity.com/feed/' }
];

const MAX_ARTICLES_PER_SOURCE = 7; 

async function generateBatchSummaries(articles) {
  if (hasQuotaExceeded || articles.length === 0) {
    return articles.map(a => ({ id: a.id, summary: QUOTA_PLACEHOLDER, tag: "Threat Intel & Info Sharing", severity: "Low" }));
  }

  const batchPrompt = `Analyze these ${articles.length} cybersecurity news headlines.
For each one, provide:
1. "id": Matches the ID provided.
2. "summary": A concise 1-2 sentence summary.
3. "tag": One of: "Malware and Vulnerabilities", "Breaches and Incidents", "Threat Intel & Info Sharing", "Laws, Policy, Regulations".
4. "severity": One of: "Critical", "High", "Low".

Articles to analyze:
${JSON.stringify(articles.map(a => ({ id: a.id, title: a.title, snippet: a.snippet || "No snippet available." })))}

Return ONLY a JSON array of objects.
Example: [{"id": "...", "summary": "...", "tag": "...", "severity": "..."}]`;

  try {
    const response = await callAIWithRetry(batchPrompt, 60000, `Batch Summary (${articles.length} items)`);
    const results = cleanAIResponse(response.text);
    return Array.isArray(results) ? results : [];
  } catch (error) {
    console.error('Batch summary failed:', error.message);
    return articles.map(a => ({ id: a.id, summary: QUOTA_PLACEHOLDER, tag: "Threat Intel & Info Sharing", severity: "Low" }));
  }
}

async function identifyTopIntel(articles) {
  if (articles.length === 0) return [];
  console.log('Identifying top 10 most impactful articles...');
  
  try {
    const listForAI = articles.map(a => ({ id: a.id, title: a.title, summary: a.summary }));
    const prompt = `Select exactly the 10 most critical/impactful articles from this list.
Return ONLY a JSON array of the "id" strings.
Articles:
${JSON.stringify(listForAI)}`;

    const response = await callAIWithRetry(prompt, 60000, "Top 10 Selection");
    const topIds = cleanAIResponse(response.text);
    return Array.isArray(topIds) ? topIds : [];
  } catch (error) {
    console.error('Top 10 selection failed:', error.message);
    return [];
  }
}

async function fetchAllNews() {
  console.log('--- Resilient Bulk Scraper (2026 Quota Shield) ---');
  
  let existingArticles = [];
  try {
    const data = await fs.readFile('articles.json', 'utf8');
    existingArticles = JSON.parse(data);
    console.log(`Loaded ${existingArticles.length} existing articles.`);
  } catch (err) {
    console.log('No existing history found.');
  }

  // 1. Scrape all RSS headlines first
  const rawHeadlines = [];
  for (const source of SOURCES) {
    console.log(`Scraping ${source.name}...`);
    try {
      const feed = await parser.parseURL(source.url);
      const items = feed.items.slice(0, MAX_ARTICLES_PER_SOURCE);
      items.forEach(item => {
        rawHeadlines.push({
          id: crypto.randomUUID(),
          source: source.name,
          title: item.title,
          snippet: item.contentSnippet,
          date: item.isoDate || item.pubDate || new Date().toISOString(),
          link: item.link
        });
      });
    } catch (err) {
      console.error(`Failed RSS pull for ${source.name}:`, err.message);
    }
  }

  // 2. Filter for headlines that need AI summaries (New OR Placeholder)
  const aiCandidates = [];
  const processedArticles = []; // Items that already have valid summaries

  const existingMap = new Map(existingArticles.map(a => [a.link, a]));
  
  rawHeadlines.forEach(raw => {
    const existing = existingMap.get(raw.link);
    if (!existing || existing.summary === QUOTA_PLACEHOLDER) {
      aiCandidates.push(raw);
    } else {
      processedArticles.push(existing);
    }
  });

  console.log(`Found ${aiCandidates.length} articles needing AI summaries.`);

  // 3. Batch Process in chunks of 14 (Respecting 20 RPD / 5 RPM)
  const BATCH_SIZE = 14;
  const summarizedNewOnes = [];

  for (let i = 0; i < aiCandidates.length; i += BATCH_SIZE) {
    if (hasQuotaExceeded) {
      // Fallback for remaining items
      aiCandidates.slice(i).forEach(raw => {
        summarizedNewOnes.push({ ...raw, summary: QUOTA_PLACEHOLDER, tag: "Threat Intel & Info Sharing", severity: "Low" });
      });
      break;
    }

    const chunk = aiCandidates.slice(i, i + BATCH_SIZE);
    console.log(`Processing Batch ${Math.floor(i/BATCH_SIZE) + 1} (${chunk.length} items)...`);
    
    // 15-second delay to stay strictly under 5 RPM
    if (i > 0) await new Promise(r => setTimeout(r, 15000));

    const results = await generateBatchSummaries(chunk);
    
    // Map AI results back to our raw objects
    chunk.forEach(raw => {
      const aiResult = results.find(r => r.id === raw.id);
      summarizedNewOnes.push({
        ...raw,
        summary: aiResult?.summary || QUOTA_PLACEHOLDER,
        tag: aiResult?.tag || "Threat Intel & Info Sharing",
        severity: aiResult?.severity || "Low"
      });
    });
  }

  // 4. Merge, Sort, and Deduplicate
  const allCurrent = [...summarizedNewOnes, ...processedArticles];
  // Final dedupe by link (safety)
  const uniqueMap = new Map();
  allCurrent.forEach(a => uniqueMap.set(a.link, a));
  
  // Re-add historical articles not in the current pull
  existingArticles.forEach(old => {
    if (!uniqueMap.has(old.link)) {
      uniqueMap.set(old.link, old);
    }
  });

  const finalCollection = Array.from(uniqueMap.values());
  finalCollection.sort((a, b) => new Date(b.date) - new Date(a.date));
  const limitedCollection = finalCollection.slice(0, 500);

  // 5. Final Top 10 Pass (Using 1 AI request)
  try {
    if (!hasQuotaExceeded) {
      await new Promise(r => setTimeout(r, 15000));
      const topTenCandidates = limitedCollection.slice(0, 70);
      const topTenIds = await identifyTopIntel(topTenCandidates);
      
      limitedCollection.forEach(article => delete article.isTopTen);
      limitedCollection.forEach(article => {
        if (topTenIds.includes(article.id)) article.isTopTen = true;
      });
    }
  } catch (err) {
    console.error('Top 10 pass failed:', err.message);
  }

  await fs.writeFile('articles.json', JSON.stringify(limitedCollection, null, 2));
  console.log(`Done! Saved ${limitedCollection.length} articles.`);
}

fetchAllNews();
