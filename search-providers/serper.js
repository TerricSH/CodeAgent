const BaseSearchProvider = require('./base-search-provider');

class SerperProvider extends BaseSearchProvider {
    async search(query, maxResults = 5) {
        const apiKey = this.config.apiKey;
        if (!apiKey) return { error: '未配置 SERPER_API_KEY' };

        const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': apiKey,
            },
            body: JSON.stringify({ q: query, num: maxResults }),
        });

        if (!res.ok) return { error: `HTTP ${res.status}` };

        const data = await res.json();
        return {
            answer: data.answerBox?.answer || data.answerBox?.snippet || null,
            results: (data.organic || []).slice(0, maxResults).map(r => ({
                title: r.title,
                url: r.link,
                content: r.snippet,
            })),
        };
    }
}

module.exports = SerperProvider;
