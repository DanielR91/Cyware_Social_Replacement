# Cyber Intel Feed (Cyware Social Replacement)

![License](https://img.shields.io/badge/License-MIT-blue.svg)

## 🌅 The Sunset of Cyware Social

On April 15, 2026, the massively popular [Cyware Social](https://social.cyware.com) platform will be officially sunset. For years, security professionals, analysts, and enthusiasts have checked Cyware Social daily to catch up on the latest open-source threat intelligence, malware updates, and vulnerability alerts. 

With its impending closure, the community is losing a highly curated, rapidly accessible dashboard for staying ahead of the global threat landscape.

## 🚀 Introducing the Replacement

This project was built to seamlessly fill that void. 

**Cyber Intel Feed** is a 100% free, fully automated, open-source alternative designed to mimic and iterate upon the best parts of the Cyware Social experience without relying on proprietary or paid infrastructure.

Instead of a massive backend team curating the news manually, this project utilizes **Google's Gemini 2.5 Flash API** to instantly ingest, analyze, summarize, and rate the severity of cybersecurity news articles around the clock.

### Key Innovations 
- **Automated AI Curation:** The engine pulls directly from the web's top 6 cybersecurity RSS feeds, asking an AI to extract a concise 2-sentence summary, assign a thematic category, and assess the threat severity ("Critical", "High", or "Low").
- **Deep Space Aesthetics:** A custom, ground-up Vanilla HTML/CSS interface featuring a dark mode, glassmorphism cards, and dynamic neon-glow categorization metrics.
- **Zero Cost Architecture:** By leveraging GitHub Actions to run the Node.js scraping script every 3 hours, and GitHub Pages to host the static HTML feed, this entire architecture operates flawlessly for $0 a month.
- **Lightning Multi-Filtering:** Instantly sort the feed via Topics, Severities, or a global Search text match. Because it runs locally in browser memory, rendering is instantaneous.

## 🧰 Tech Stack
- **Frontend**: Vanilla HTML5, Vanilla JavaScript, CSS3
- **Backend (Scraper)**: Node.js, `rss-parser`, `@google/genai`
- **Automation & Hosting**: GitHub Actions & GitHub Pages

## 🗞️ Default Intelligence Sources
The feed is currently aggregating updates from:
- BleepingComputer
- The Hacker News
- CyberScoop
- The Register
- HackRead
- The Record
