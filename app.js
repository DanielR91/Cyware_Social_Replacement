// Initialize Lucide icons
lucide.createIcons();

document.addEventListener('DOMContentLoaded', () => {
    fetchArticles();
});

async function fetchArticles() {
    const container = document.getElementById('articles-container');
    const template = document.getElementById('article-template');

    try {
        // Fetch the generated JSON from the GitHub Action scraper
        const response = await fetch('articles.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const articles = await response.json();
        
        // Clear loader
        container.innerHTML = '';
        
        // Render articles
        articles.forEach(article => {
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
            
            // Format date (e.g., "Just now", "2 hours ago", or simple locale date)
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
