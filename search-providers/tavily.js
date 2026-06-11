const BaseSearchProvider = require('./BaseSearchProvider');

class TavilyProvider extends BaseSearchProvider {
    async search(query, maxResults = 5) {
        const apiKey = this.config.apiKey;
        if (!apiKey) return { error: '未配置 TAVILY_API_KEY' };

        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_results: maxResults,
                include_answer: true,
            }),
        });

        if (!res.ok) return { error: `HTTP ${res.status}` };

        const data = await res.json();
        return {
            answer: data.answer || null,
            results: (data.results || []).map(r => ({
                title: r.title,
                url: r.url,
                content: r.content,
            })),
        };
    }
}

module.exports = TavilyProvider;
