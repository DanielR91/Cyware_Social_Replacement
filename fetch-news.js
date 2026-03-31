import Parser from 'rss-parser';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import crypto from 'crypto';

// Initialize RSS Parser and Gemini Client
const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); // Assumes GEMINI_API_KEY is securely injected via GitHub Secrets

const SOURCES = [
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'CyberScoop', url: 'https://cyberscoop.com/feed/' },
  { name: 'The Register', url: 'https://www.theregister.com/security/headlines.atom' },
  { name: 'HackRead', url: 'https://hackread.com/feed/' },
  { name: 'The Record', url: 'https://therecord.media/feed' }
];

const MAX_ARTICLES_PER_SOURCE = 3; // Keep it low to minimize API processing time

async function generateSummaryAndTag(title, snippet) {
  try {
    const prompt = `Analyze this cybersecurity news article.
Title: ${title}
Snippet: ${snippet || 'No snippet available.'}

Provide two things in JSON format:
1. "summary": A concise 1-2 sentence summary of what the article is about.
2. "tag": A categorization tag (must be one of: "Malware and Vulnerabilities", "Breaches and Incidents", "Threat Intel & Info Sharing", "Laws, Policy, Regulations").

Return ONLY valid JSON.
Example: {"summary": "A new malware campaign is targeting Windows users.", "tag": "Malware and Vulnerabilities"}`;

    // Using the free tier model: gemini-2.5-flash
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json"
        }
    });

    const parsed = JSON.parse(response.text);
    return {
      summary: parsed.summary || "Summary generation failed.",
      tag: parsed.tag || "Threat Intel & Info Sharing"
    };
  } catch (error) {
    console.error(`Error generating summary for "${title}":`, error.message);
    return { summary: "No summary available.", tag: "Threat Intel & Info Sharing" };
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
        // Sleep slightly to respect rate limits if there are many articles
        await new Promise(r => setTimeout(r, 1000));
        
        console.log(`   -> Summarizing: ${item.title}`);
        const { summary, tag } = await generateSummaryAndTag(item.title, item.contentSnippet);

        allArticles.push({
          id: crypto.randomUUID(),
          source: source.name,
          tag: tag,
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

  // Save to articles.json
  await fs.writeFile('articles.json', JSON.stringify(allArticles, null, 2));
  console.log(`Successfully saved ${allArticles.length} articles to articles.json`);
}

fetchAllNews();
