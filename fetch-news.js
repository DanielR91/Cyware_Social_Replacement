import Parser from 'rss-parser';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import crypto from 'crypto';

// Initialize RSS Parser and Gemini Client
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  }
});
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// We track two separate quota states in our Hybrid Model (2026 Edition)
let quotaExceededPremium = false;
let quotaExceededLite = false;

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
 * Supports two tiers: 
 * - gemini-3.1-flash-lite-preview (High Volume Efficiency Tier)
 * - gemini-2.5-flash (Low Volume Quality/Premium Tier)
 */
async function callAIWithRetry(prompt, timeoutMs, operationName, modelName, retries = 3) {
  // Check localized quota flags
  if (modelName.includes("lite") && quotaExceededLite) throw new Error("QUOTA_EXCEEDED_LITE");
  if (modelName.includes("2.5") && quotaExceededPremium) throw new Error("QUOTA_EXCEEDED_PREMIUM");

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
      
      // Determine if this is a "Daily Budget" fail (2026 edition)
      const isDailyExhausted = msg.includes("quota") && (msg.includes("daily") || msg.includes("budget") || msg.includes("rpd") || msg.includes("exceeded") || msg.includes("metric"));

      if (isDailyExhausted) {
        if (modelName.includes("lite")) quotaExceededLite = true;
        if (modelName.includes("2.5")) quotaExceededPremium = true;
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
  if (quotaExceededLite) return { summary: QUOTA_PLACEHOLDER, tag: "Threat Intel & Info Sharing", severity: "Low" };

  try {
    const prompt = `Analyze this cybersecurity news headline.
Title: ${title}
Snippet: ${snippet || 'No snippet available.'}

Provide JSON:
1. "summary": Concise 1-2 sentence summary.
2. "tag": One of ["Malware and Vulnerabilities", "Breaches and Incidents", "Threat Intel & Info Sharing", "Laws, Policy, Regulations"].
3. "severity": ["Critical", "High", "Low"].`;

    // Using the current 2026 "Lite" efficiency model for high-volume summaries
    const response = await callAIWithRetry(prompt, 30000, `Summary: ${title.substring(0, 30)}`, 'gemini-3.1-flash-lite-preview');
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
  if (articles.length === 0) return [];
  
  // Strategy: Try Premium Model (2.5) first, fallback to Lite (3.1) if quota hit
  const modelsToTry = ['gemini-2.5-flash', 'gemini-3.1-flash-lite-preview'];

  for (const modelName of modelsToTry) {
    if (modelName.includes("2.5") && quotaExceededPremium) continue;
    if (modelName.includes("lite") && quotaExceededLite) continue;

    console.log(`Identifying top 10 most impactful articles using ${modelName}...`);
    try {
      const listForAI = articles.map((a, idx) => ({ index: idx, title: a.title, summary: a.summary }));
      const prompt = `Select exactly the 10 most critical/impactful articles from this list.
Return ONLY a JSON array of the "index" integers (0-based).
Articles: ${JSON.stringify(listForAI)}`;

      const response = await callAIWithRetry(prompt, 60000, `Top 10 (${modelName})`, modelName);
      const topIndices = cleanAIResponse(response.text);
      
      if (!Array.isArray(topIndices)) return [];
      
      // Map indices back to article IDs safely
      return topIndices
        .filter(idx => typeof idx === 'number' && articles[idx])
        .map(idx => articles[idx].id);
    } catch (error) {
      if (error.message === "QUOTA_EXCEEDED" && modelName.includes("2.5")) {
        console.warn('Premium model quota hit. Falling back to Lite model for Top 10 selection...');
        continue; // Try the next model in the list
      }
      console.error(`Top 10 pass failed for ${modelName}:`, error.message);
      // If it's a Lite model failure or anything else, don't keep looping
      break; 
    }
  }
  return [];
}

async function fetchAllNews() {
  console.log('--- 2026 Hybrid Architecture: Flash-Lite (Summaries) & 2.5-Flash (Top 10) ---');
  
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
          
          // 12-second delay to stay strictly under the 5 RPM project-wide limit (60s / 5 = 12s)
          await new Promise(r => setTimeout(r, 12000));
          
          console.log(`   -> AI Summary (Lite): ${item.title}`);
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

  // Identify Top 10 (Using Premium Tier)
  try {
    const topTenCandidates = limitedCollection.slice(0, 70);
    // Mandatory 60s cooldown to ensure the RPM bucket is completely empty for the premium pass
    console.log('Final 60s cooldown to clear project RPM for the Premium Model pass...');
    await new Promise(r => setTimeout(r, 60000));

    const topTenIds = await identifyTopIntel(topTenCandidates);
    limitedCollection.forEach(article => {
      article.isTopTen = topTenIds.includes(article.id);
    });
  } catch (err) {}

  await fs.writeFile('articles.json', JSON.stringify(limitedCollection, null, 2));
  console.log(`Successfully saved ${limitedCollection.length} articles.`);
}

fetchAllNews().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
