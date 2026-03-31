// Global State
let allArticles = [];
let activeCategory = null;
let activeSeverity = null;

// Initialize Lucide icons
lucide.createIcons();

document.addEventListener('DOMContentLoaded', () => {
    setupFilters();
    fetchArticles();
});

async function fetchArticles() {
    const container = document.getElementById('articles-container');

    try {
        // Fetch the generated JSON from the GitHub Action scraper
        const response = await fetch('articles.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        allArticles = await response.json();
        
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
    
    // Filter logic
    const filteredArticles = allArticles.filter(article => {
        let matchCategory = true;
        let matchSeverity = true;
        
        if (activeCategory) {
            matchCategory = (article.tag === activeCategory);
        }
        
        if (activeSeverity) {
            matchSeverity = (article.severity === activeSeverity);
        }
        
        return matchCategory && matchSeverity;
    });

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
        
        // Populate data
        clone.querySelector('.source-tag').textContent = article.source;
        clone.querySelector('.category-tag').textContent = article.tag;
        
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
            } else if (btn.dataset.category) {
                if (activeCategory === btn.dataset.category) {
                    activeCategory = null; 
                } else {
                    activeCategory = btn.dataset.category;
                }
            } else if (btn.dataset.severity) {
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
    });
    
    if (!anyActive) {
        const resetBtn = document.querySelector('[data-reset="true"]');
        if (resetBtn) resetBtn.classList.add('active');
    }
}
