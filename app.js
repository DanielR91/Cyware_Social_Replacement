// Global State
let allArticles = [];
let savedArticles = JSON.parse(localStorage.getItem('savedBookmarkedIntel') || '[]');
let activeCategory = localStorage.getItem('defaultCategory') || null;
let activeSeverity = localStorage.getItem('defaultSeverity') || null;
let activeSaved = false;
let activeTopTen = false;
let currentSearchQuery = "";
let currentSort = "Latest";
let activeView = "feed";
let dailyBriefing = "Strategic situational briefing is being generated...";

// Initialize Lucide icons
lucide.createIcons();

document.addEventListener('DOMContentLoaded', () => {
    setupFilters();
    setupSearch();
    setupModal();
    setupSort();
    setupTabs();
    fetchArticles();
    
    // Auto-apply initial UI states from localStorage if they exist
    if (activeCategory || activeSeverity) {
        updateFilterUI();
    }
});

async function fetchArticles() {
    const container = document.getElementById('articles-container');

    try {
        // Fetch the generated JSON from the GitHub Action scraper
        const response = await fetch('articles.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Handle both old (array) and new (object) structures
        if (Array.isArray(data)) {
            allArticles = data;
        } else {
            allArticles = data.articles || [];
            dailyBriefing = data.dailyBriefing || dailyBriefing;
            displayLastUpdated(data.lastUpdated);
        }
        
        // Render articles
        renderArticles();
        
    } catch (error) {
        console.error('Failed to load articles:', error);
        container.innerHTML = `
            <div style="color: #ff4a4a; padding: 2rem; text-align: center;">
                <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin-bottom: 1rem;"></i>
                <p>Failed to load intel feed. Make sure you are viewing via a web server or GitHub Pages.</p>
            </div>
        `;
        lucide.createIcons();
    }
}

function renderArticles() {
    const container = document.getElementById('articles-container');
    const template = document.getElementById('article-template');
    
    // Determine data source
    const sourceArray = activeSaved ? savedArticles : allArticles;
    
    // Filter logic
    const filteredArticles = sourceArray.filter(article => {
        let matchCategory = true;
        let matchSeverity = true;
        let matchSearch = true;
        let matchTopTen = true;
        
        if (activeTopTen) {
            matchTopTen = (article.isTopTen === true);
        }

        if (activeCategory) {
            matchCategory = (article.tag === activeCategory);
        }
        
        if (activeSeverity) {
            matchSeverity = (article.severity === activeSeverity);
        }

        if (currentSearchQuery) {
            const query = currentSearchQuery.toLowerCase();
            const textToSearch = `${article.title} ${article.summary}`.toLowerCase();
            matchSearch = textToSearch.includes(query);
        }
        
        return matchCategory && matchSeverity && matchSearch && matchTopTen;
    });

    // Apply Sorting
    // Apply Sorting
    if (String(currentSort) === "Severity") {
        const severityWeight = { "Critical": 3, "High": 2, "Low": 1 };
        filteredArticles.sort((a, b) => {
            const wA = severityWeight[a.severity] || 0;
            const wB = severityWeight[b.severity] || 0;
            if (wA !== wB) return wB - wA; // Highest severity first
            return new Date(b.date) - new Date(a.date); // Then newest first
        });
    } else {
        // Default: Sort by Date only
        filteredArticles.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    container.innerHTML = '';

    if (filteredArticles.length === 0) {
        container.innerHTML = `
            <div style="color: var(--text-muted); padding: 3rem; text-align: center;">
                <i data-lucide="list-x" style="width: 48px; height: 48px; margin-bottom: 1rem; opacity: 0.5;"></i>
                <p>No articles match your current filters.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    // Render articles
    filteredArticles.forEach(article => {
        const clone = template.content.cloneNode(true);
        const card = clone.querySelector('.article-card');
        
        // Populate data
        clone.querySelector('.source-tag').textContent = article.source;
        clone.querySelector('.category-tag').textContent = article.tag;
        
        // Handle Top 10 Styling
        if (article.isTopTen) {
            card.classList.add('is-top-ten');
            clone.querySelector('.top-ten-badge').style.display = 'flex';
        }

        const severityTag = clone.querySelector('.severity-tag');
        if (article.severity) {
            severityTag.textContent = article.severity;
            severityTag.classList.add(`severity-${article.severity.toLowerCase()}`);
        } else {
            severityTag.style.display = 'none';
        }
        
        const titleLink = clone.querySelector('.article-title a');
        titleLink.textContent = article.title;
        titleLink.href = article.link;
        
        clone.querySelector('.article-summary').textContent = article.summary;
        
        // Handle Bookmark State
        const bookmarkBtn = clone.querySelector('.bookmark-btn');
        const isBookmarked = savedArticles.some(saved => saved.link === article.link);
        if (isBookmarked) {
            bookmarkBtn.classList.add('bookmarked');
        }
        
        bookmarkBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const existsIndex = savedArticles.findIndex(saved => saved.link === article.link);
            
            if (existsIndex >= 0) {
                savedArticles.splice(existsIndex, 1);
                bookmarkBtn.classList.remove('bookmarked');
                localStorage.setItem('savedBookmarkedIntel', JSON.stringify(savedArticles));
                if (activeSaved) {
                    renderArticles();
                    return; // Stop execution since DOM is wiped
                }
            } else {
                savedArticles.push(article);
                bookmarkBtn.classList.add('bookmarked');
                localStorage.setItem('savedBookmarkedIntel', JSON.stringify(savedArticles));
            }
        });
        
        // Handle Share Button
        const shareBtn = clone.querySelector('.share-btn');
        shareBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const shareData = {
                title: article.title,
                text: article.summary,
                url: article.link
            };

            try {
                if (navigator.share) {
                    await navigator.share(shareData);
                } else {
                    await navigator.clipboard.writeText(article.link);
                    // Provide quick visual feedback
                    const originalColor = shareBtn.style.color;
                    shareBtn.style.color = "var(--neon-green)";
                    setTimeout(() => {
                        shareBtn.style.color = originalColor;
                    }, 1500);
                }
            } catch (err) {
                console.error('Error sharing or copying to clipboard:', err);
            }
        });
        
        // Format date
        const dateObj = new Date(article.date);
        const formattedDate = dateObj.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        clone.querySelector('.article-date').textContent = formattedDate;
        
        // Append to DOM
        container.appendChild(clone);
    });

    // Re-initialize icons for newly added elements
    lucide.createIcons();
}

function setupFilters() {
    const filterBtns = document.querySelectorAll('.filter-btn');
    
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            if (btn.dataset.reset) {
                activeCategory = null;
                activeSeverity = null;
                activeSaved = false;
                activeTopTen = false;
            } else if (btn.dataset.saved) {
                activeSaved = true;
                activeTopTen = false;
                activeCategory = null;
                activeSeverity = null;
            } else if (btn.dataset.topten) {
                activeTopTen = true;
                activeSaved = false;
                activeCategory = null;
                activeSeverity = null;
            } else if (btn.dataset.category) {
                activeSaved = false;
                activeTopTen = false;
                if (activeCategory === btn.dataset.category) {
                    activeCategory = null; 
                } else {
                    activeCategory = btn.dataset.category;
                }
            } else if (btn.dataset.severity) {
                activeSaved = false;
                activeTopTen = false;
                if (activeSeverity === btn.dataset.severity) {
                    activeSeverity = null;
                } else {
                    activeSeverity = btn.dataset.severity;
                }
            }
            
            updateFilterUI();
            renderArticles();
        });
    });
}

function updateFilterUI() {
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => btn.classList.remove('active'));
    
    let anyActive = false;
    
    filterBtns.forEach(btn => {
        if (btn.dataset.category && btn.dataset.category === activeCategory) {
            btn.classList.add('active');
            anyActive = true;
        }
        if (btn.dataset.severity && btn.dataset.severity === activeSeverity) {
            btn.classList.add('active');
            anyActive = true;
        }
        if (btn.dataset.saved && activeSaved) {
            btn.classList.add('active');
            anyActive = true;
        }
        if (btn.dataset.topten && activeTopTen) {
            btn.classList.add('active');
            anyActive = true;
        }
    });
    
    if (!anyActive) {
        const resetBtn = document.querySelector('[data-reset="true"]');
        if (resetBtn) resetBtn.classList.add('active');
    }
}

function setupSearch() {
    const searchBtn = document.getElementById('search-toggle-btn');
    const searchInput = document.getElementById('search-input');
    
    if (!searchBtn || !searchInput) return;

    searchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        searchInput.classList.toggle('expanded');
        if (searchInput.classList.contains('expanded')) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            currentSearchQuery = '';
            renderArticles();
        }
    });
    
    searchInput.addEventListener('input', (e) => {
        currentSearchQuery = e.target.value.trim();
        renderArticles();
    });
}

function setupModal() {
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('close-modal-btn');
    const saveBtn = document.getElementById('save-preferences-btn');
    const catSelect = document.getElementById('default-category');
    const sevSelect = document.getElementById('default-severity');

    if (!settingsBtn || !modal) return;

    // Open modal and prepopulate selects
    settingsBtn.addEventListener('click', () => {
        catSelect.value = localStorage.getItem('defaultCategory') || "";
        sevSelect.value = localStorage.getItem('defaultSeverity') || "";
        modal.showModal();
    });

    // Close button
    closeBtn.addEventListener('click', () => {
        modal.close();
    });

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        const dialogDimensions = modal.getBoundingClientRect();
        if (
            e.clientX < dialogDimensions.left ||
            e.clientX > dialogDimensions.right ||
            e.clientY < dialogDimensions.top ||
            e.clientY > dialogDimensions.bottom
        ) {
            modal.close();
        }
    });

    // Save preferences
    saveBtn.addEventListener('click', () => {
        const selectedCat = catSelect.value;
        const selectedSev = sevSelect.value;
        
        if (selectedCat) localStorage.setItem('defaultCategory', selectedCat);
        else localStorage.removeItem('defaultCategory');
        
        if (selectedSev) localStorage.setItem('defaultSeverity', selectedSev);
        else localStorage.removeItem('defaultSeverity');
        
        activeCategory = selectedCat || null;
        activeSeverity = selectedSev || null;
        
        modal.close();
        updateFilterUI();
        renderArticles();
    });
}

function setupTabs() {
    const navLinks = document.querySelectorAll('.nav-link');
    const feedView = document.getElementById('feed-view');
    const dashboardView = document.getElementById('dashboard-view');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.dataset.view;
            if (view === activeView) return;

            activeView = view;
            
            // Toggle UI
            navLinks.forEach(nl => nl.classList.remove('active'));
            link.classList.add('active');

            if (view === 'dashboard') {
                feedView.style.display = 'none';
                dashboardView.style.display = 'block';
                renderDashboard();
            } else {
                feedView.style.display = 'block';
                dashboardView.style.display = 'none';
                renderArticles();
            }
        });
    });
}

function renderDashboard() {
    // 1. Briefing
    document.getElementById('ai-briefing-text').textContent = dailyBriefing;

    // 2. Severity Analytics
    const severityChart = document.getElementById('severity-chart');
    const sevCounts = { Critical: 0, High: 0, Low: 0 };
    allArticles.forEach(a => { if (sevCounts[a.severity] !== undefined) sevCounts[a.severity]++; });
    
    severityChart.innerHTML = '';
    ['Critical', 'High', 'Low'].forEach(label => {
        const count = sevCounts[label];
        const percent = allArticles.length ? (count / allArticles.length * 100) : 0;
        severityChart.appendChild(createChartBar(label, count, percent, `severity-${label.toLowerCase()}`));
    });

    // 3. Topics Analytics
    const topicsChart = document.getElementById('topics-chart');
    const topicCounts = {};
    allArticles.forEach(a => { 
        if (a.tag) { topicCounts[a.tag] = (topicCounts[a.tag] || 0) + 1; }
    });

    // Sort topics by count
    const sortedTopics = Object.entries(topicCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
    topicsChart.innerHTML = '';
    sortedTopics.forEach(([label, count]) => {
        const percent = allArticles.length ? (count / allArticles.length * 100) : 0;
        topicsChart.appendChild(createChartBar(label, count, percent, 'topic-default'));
    });
}

function createChartBar(label, count, percent, colorClass) {
    const row = document.createElement('div');
    row.className = 'chart-bar-row';
    row.innerHTML = `
        <div class="bar-info">
            <span class="bar-label">${label}</span>
            <span class="bar-value">${count} items (${Math.round(percent)}%)</span>
        </div>
        <div class="bar-track">
            <div class="bar-fill ${colorClass}" style="width: 0%"></div>
        </div>
    `;
    
    // Trigger animation after append
    setTimeout(() => {
        const fill = row.querySelector('.bar-fill');
        if (fill) fill.style.width = `${Math.max(percent, 2)}%`;
    }, 100);

    return row;
}
