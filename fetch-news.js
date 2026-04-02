import Parser from 'rss-parser';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import crypto from 'crypto';

// Initialize RSS Parser and Gemini Client
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// We track two separate quota states in our Hybrid Model
let quotaExceeded25 = false;
let quotaExceeded8B = false;

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

/**
 * Hybrid Helper for AI calls. 
 * Supports two models: 
 * - gemini-1.5-flash-8b (High Volume, 1,500 RPD)
 * - gemini-2.5-flash (Low Volume, 20 RPD)
 */
async function callAIWithRetry(prompt, timeoutMs, operationName, modelName, retries = 3) {
  // Check localized quota flags
  if (modelName.includes("2.5") && quotaExceeded25) throw new Error("QUOTA_EXCEEDED_25");
  if (modelName.includes("8b") && quotaExceeded8B) throw new Error("QUOTA_EXCEEDED_8B");

  let attempt = 0;
  while (attempt <= retries) {
    try {
      const response = await withTimeout(ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      }), timeoutMs, operationName);
      return response;
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      
      // Determine if this is a "Daily Budget" fail
      const isDailyExhausted = msg.includes("quota") && (msg.includes("daily") || msg.includes("budget") || msg.includes("rpd"));

      if (isDailyExhausted) {
        if (modelName.includes("2.5")) quotaExceeded25 = true;
        if (modelName.includes("8b")) quotaExceeded8B = true;
        console.error(`[FATAL] Daily Quota Exceeded for ${modelName}. Switching to fallback mode.`);
        throw new Error("QUOTA_EXCEEDED");
      }

      // Handle temporary 429/503 Busy errors
      if ((msg.includes("429") || msg.includes("503")) && attempt < retries) {
        attempt++;
        const wait = 60000 * attempt; 
        console.warn(`[Retry Needed] ${modelName} is busy. Pausing for ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`AI Call Failed (${modelName}):`, msg);
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

async function generateSummaryAndTag(title, snippet) {
  if (quotaExceeded8B) return { summary: QUOTA_PLACEHOLDER, tag: "Threat Intel & Info Sharing", severity: "Low" };

  try {
    const prompt = `Analyze this cybersecurity news headline.
Title: ${title}
Snippet: ${snippet || 'No snippet available.'}

Provide JSON:
1. "summary": Concise 1-2 sentence summary.
2. "tag": One of ["Malware and Vulnerabilities", "Breaches and Incidents", "Threat Intel & Info Sharing", "Laws, Policy, Regulations"].
3. "severity": ["Critical", "High", "Low"].`;

    // Using the "High Quota" 8B model for high-volume summarization
    const response = await callAIWithRetry(prompt, 30000, `Summary: ${title.substring(0, 30)}`, 'gemini-1.5-flash-8b');
    const parsed = cleanAIResponse(response.text);
    return {
      summary: parsed.summary || "Summary failed.",
      tag: parsed.tag || "Threat Intel & Info Sharing",
      severity: parsed.severity || "Low"
    };
  } catch (error) {
    return { summary: "Service busy.", tag: "Threat Intel & Info Sharing", severity: "Low" };
  }
}

async function identifyTopIntel(articles) {
  if (articles.length === 0 || quotaExceeded25) return [];
  console.log('Identifying top 10 most impactful articles using 2.5 Flash...');
  
  try {
    const listForAI = articles.map(a => ({ id: a.id, title: a.title, summary: a.summary }));
    const prompt = `Select exactly the 10 most critical/impactful articles from this list.
Return ONLY a JSON array of the "id" strings.
Articles: ${JSON.stringify(listForAI)}`;

    // Using the "High IQ" 2.5 model for final selection pass (stayers under 20 RPD)
    const response = await callAIWithRetry(prompt, 60000, "Top 10 Selection", 'gemini-2.5-flash');
    const topIds = cleanAIResponse(response.text);
    return Array.isArray(topIds) ? topIds : [];
  } catch (error) {
    console.error('Top 10 pass failed:', error.message);
    return [];
  }
}

async function fetchAllNews() {
  console.log('--- Hybrid Model Scraper: 1.5-8B (Summaries) & 2.5 (Top 10) ---');
  
  let existingArticles = [];
  try {
    const data = await fs.readFile('articles.json', 'utf8');
    existingArticles = JSON.parse(data);
  } catch (err) {}

  const newArticles = [];
  const existingMap = new Map((existingArticles || []).map(a => [a.link, a]));

  for (const source of SOURCES) {
    console.log(`Pulling ${source.name}...`);
    try {
      const feed = await parser.parseURL(source.url);
      const items = feed.items.slice(0, MAX_ARTICLES_PER_SOURCE);

      for (const item of items) {
        const existing = existingMap.get(item.link);
        // Only summarize if it's NEW or currently has a Placeholder
        if (!existing || existing.summary === QUOTA_PLACEHOLDER) {
          
          // 5-second delay to stay strictly under the 1.5-8B free tier RPM limits
          await new Promise(r => setTimeout(r, 5000));
          
          console.log(`   -> AI Summary (8B): ${item.title}`);
          const { summary, tag, severity } = await generateSummaryAndTag(item.title, item.contentSnippet);
          
          newArticles.push({
            id: crypto.randomUUID(),
            source: source.name,
            tag, severity, title: item.title, summary,
            date: item.isoDate || item.pubDate || new Date().toISOString(),
            link: item.link
          });
        } else {
          newArticles.push(existing);
        }
      }
    } catch (err) {
      console.error(`Source ${source.name} failed:`, err.message);
    }
  }

  // Deduplicate and merge history
  const uniqueMap = new Map();
  newArticles.forEach(a => uniqueMap.set(a.link, a));
  existingArticles.forEach(old => {
    if (!uniqueMap.has(old.link)) uniqueMap.set(old.link, old);
  });

  const finalCollection = Array.from(uniqueMap.values());
  finalCollection.sort((a, b) => new Date(b.date) - new Date(a.date));
  const limitedCollection = finalCollection.slice(0, 500);

  // Identify Top 10 (Using 2.5 Flash)
  try {
    const topTenCandidates = limitedCollection.slice(0, 70);
    const topTenIds = await identifyTopIntel(topTenCandidates);
    limitedCollection.forEach(article => {
      article.isTopTen = topTenIds.includes(article.id);
    });
  } catch (err) {}

  await fs.writeFile('articles.json', JSON.stringify(limitedCollection, null, 2));
  console.log(`Successfully saved ${limitedCollection.length} articles.`);
}

fetchAllNews();
