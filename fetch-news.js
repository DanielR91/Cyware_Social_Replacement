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

const MAX_ARTICLES_PER_SOURCE = 10; // 60 total per run

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

    // Using the official SDK: gemini-2.5-flash
    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            responseMimeType: "application/json"
        }
    }), 30000, `Summary for: ${title}`);

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

    const response = await withTimeout(ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            responseMimeType: "application/json"
        }
    }), 60000, "Top 10 Intel Selection");

    const topIds = cleanAIResponse(response.text);
    return Array.isArray(topIds) ? topIds : [];
  } catch (error) {
    console.error('Error identifying Top 10:', error.message);
    return [];
  }
}

async function fetchAllNews() {
  console.log('Fetching cybersecurity news...');
  const allArticles = [];

  for (const source of SOURCES) {
    console.log(`Pulling ${source.name}...`);
    try {
      const feed = await parser.parseURL(source.url);
      const latestItems = feed.items.slice(0, MAX_ARTICLES_PER_SOURCE);

      for (const item of latestItems) {
        // Sleep 4.5 seconds to stay strictly under the free tier 15 Requests Per Minute limit
        await new Promise(r => setTimeout(r, 4500));
        
        console.log(`   -> Summarizing: ${item.title}`);
        const { summary, tag, severity } = await generateSummaryAndTag(item.title, item.contentSnippet);

        allArticles.push({
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
      console.error(`Failed to fetch ${source.name}:`, err.message);
    }
  }

  // Sort by date newest first
  allArticles.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Identify Top 10 using AI (Fail-safe)
  try {
    const topTenIds = await identifyTopIntel(allArticles);
    allArticles.forEach(article => {
      if (topTenIds.includes(article.id)) {
        article.isTopTen = true;
      }
    });
  } catch (err) {
    console.error('Final Top 10 pass failed, proceeding with standard feed update:', err.message);
  }

  // Save to articles.json
  await fs.writeFile('articles.json', JSON.stringify(allArticles, null, 2));
  console.log(`Successfully saved ${allArticles.length} articles to articles.json`);
}

fetchAllNews();
