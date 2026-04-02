import Parser from 'rss-parser';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import crypto from 'crypto';

// Initialize RSS Parser and Gemini Client
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
      // Check for permanent Quota Exceeded vs temporary Rate Limit
      if (msg.toLowerCase().includes("quota")) {
        console.error(`[FATAL] Daily Quota Exceeded. Aborting run.`);
        throw new Error("QUOTA_EXCEEDED");
      }

      if (msg.includes("429") && attempt < retries) {
        attempt++;
        const wait = 60000 * attempt; // 60s, 120s, etc.
        console.warn(`[429 Rate Limit] "${operationName}" - Pausing for ${wait/1000}s... (Attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
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

const MAX_ARTICLES_PER_SOURCE = 7; // 70 total per run to save quota

async function generateSummaryAndTag(title, snippet) {
  try {
    const prompt = `Analyze this cybersecurity news article.
Title: ${title}
Snippet: ${snippet || 'No snippet available.'}

Provide three things in JSON format:
1. "summary": A concise 1-2 sentence summary of what the article is about.
2. "tag": A categorization tag (must be one of: "Malware and Vulnerabilities", "Breaches and Incidents", "Threat Intel & Info Sharing", "Laws, Policy, Regulations").
3. "severity": The threat severity rating (must be one of: "Critical", "High", "Low").

Return ONLY valid JSON.
Example: {"summary": "A new malware campaign is targeting Windows users.", "tag": "Malware and Vulnerabilities", "severity": "High"}`;

    // Using the official SDK: gemini-2.5-flash with safety retry
    const response = await callAIWithRetry(prompt, 30000, `Summary for: ${title}`);

    const parsed = cleanAIResponse(response.text);
    return {
      summary: parsed.summary || "Summary generation failed.",
      tag: parsed.tag || "Threat Intel & Info Sharing",
      severity: parsed.severity || "Low"
    };
  } catch (error) {
    console.error(`Error generating summary for "${title}":`, error.message);
    return { summary: "No summary available.", tag: "Threat Intel & Info Sharing", severity: "Low" };
  }
}

async function identifyTopIntel(articles) {
  if (articles.length === 0) return [];
  
  console.log('Identifying top 10 most impactful articles...');
  
  try {
    const listForAI = articles.map(a => ({ id: a.id, title: a.title, summary: a.summary }));
    const prompt = `You are a Senior Threat Intelligence Analyst. 
Below is a list of cybersecurity news articles collected today. 
Select exactly the 10 most critical or impactful articles that a CISO should prioritize.
Base your selection on: 
1. Impact (Global breaches, supply chain attacks, etc.)
2. Exploitability (Zero-days, RCE with public PoCs).
3. Strategic Importance (Nation-state actors, major policy changes).

Articles:
${JSON.stringify(listForAI)}

Return ONLY a JSON array of the "id" strings for your top 10 selections.
Example: ["id1", "id2", "id3", ...]`;

    const response = await callAIWithRetry(prompt, 60000, "Top 10 Intel Selection");

    const topIds = cleanAIResponse(response.text);
    return Array.isArray(topIds) ? topIds : [];
  } catch (error) {
    console.error('Error identifying Top 10:', error.message);
    return [];
  }
}

async function fetchAllNews() {
  console.log('Loading existing news and fetching new reports...');
  
  // Load existing articles so we don't start from an empty file
  let existingArticles = [];
  try {
    const data = await fs.readFile('articles.json', 'utf8');
    existingArticles = JSON.parse(data);
    console.log(`Successfully loaded ${existingArticles.length} existing articles.`);
  } catch (err) {
    console.log('No existing articles.json found or file is empty.');
  }

  const newArticles = [];

  for (const source of SOURCES) {
    console.log(`Pulling ${source.name}...`);
    try {
      const feed = await parser.parseURL(source.url);
      const latestItems = feed.items.slice(0, MAX_ARTICLES_PER_SOURCE);

      for (const item of latestItems) {
        // Sleep 6 seconds to stay strictly under the free tier 15 Requests Per Minute limit (safer 10 RPM)
        await new Promise(r => setTimeout(r, 6000));
        
        console.log(`   -> Summarizing: ${item.title}`);
        const { summary, tag, severity } = await generateSummaryAndTag(item.title, item.contentSnippet);

        newArticles.push({
          id: crypto.randomUUID(),
          source: source.name,
          tag: tag,
          severity: severity,
          title: item.title,
          summary: summary,
          date: item.isoDate || item.pubDate || new Date().toISOString(),
          link: item.link
        });
      }
    } catch (err) {
      if (err.message === "QUOTA_EXCEEDED") {
        console.warn(`Stopping scrape early due to quota exhaustion. Saving partial results (${newArticles.length} new items)...`);
        break; // Break the SOURCES loop to jump to the save step
      }
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  // Merge and Deduplicate (by link)
  console.log('Merging and deduplicating news...');
  const combined = [...newArticles];
  const seenLinks = new Set(newArticles.map(a => a.link));
  
  existingArticles.forEach(old => {
    if (!seenLinks.has(old.link)) {
      combined.push(old);
      seenLinks.add(old.link);
    }
  });

  // Sort by date newest first
  combined.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Limit to 500 most recent items to keep file size optimized
  const finalArticles = combined.slice(0, 500);

  // Identify Top 10 using AI (Fail-safe) - Run this on the most recent 70 items
  try {
    const topTenCandidates = finalArticles.slice(0, 70);
    const topTenIds = await identifyTopIntel(topTenCandidates);
    
    // Clear old flags first (on our final set)
    finalArticles.forEach(article => delete article.isTopTen);

    // Apply new Top 10 flags
    finalArticles.forEach(article => {
      if (topTenIds.includes(article.id)) {
        article.isTopTen = true;
      }
    });
  } catch (err) {
    console.error('Final Top 10 pass failed, proceeding with standard feed update:', err.message);
  }

  // Save to articles.json
  await fs.writeFile('articles.json', JSON.stringify(finalArticles, null, 2));
  console.log(`Successfully saved ${finalArticles.length} total articles to articles.json`);
}

fetchAllNews();
