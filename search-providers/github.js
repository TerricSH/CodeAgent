const BaseSearchProvider = require('./base-search-provider');

const ENDPOINTS = {
    repositories: 'repositories',
    code: 'code',
    issues: 'issues',
    users: 'users',
};

function formatItem(type, item) {
    if (type === 'repositories') {
        return { title: item.full_name, url: item.html_url, content: item.description || '' };
    }
    if (type === 'code') {
        return { title: `${item.repository?.full_name || ''}/${item.path}`, url: item.html_url, content: `file: ${item.name}` };
    }
    if (type === 'issues') {
        return { title: item.title, url: item.html_url, content: `${item.state} #${item.number}` };
    }
    if (type === 'users') {
        return { title: item.login, url: item.html_url, content: item.type || '' };
    }
    return { title: item.name || item.full_name || item.login || item.title || '', url: item.html_url || item.url, content: item.description || '' };
}

class GitHubProvider extends BaseSearchProvider {
    async search(query, maxResults = 5, options = {}) {
        const apiBaseUrl = this.config.apiBaseUrl || 'https://api.github.com';
        const type = options.type || 'repositories';
        const endpoint = ENDPOINTS[type] || ENDPOINTS.repositories;

        const url = new URL(`/search/${endpoint}`, apiBaseUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('per_page', maxResults);

        const headers = {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'CodeAgent',
            'X-GitHub-Api-Version': '2022-11-28',
        };

        if (this.config.token) {
            headers.Authorization = `Bearer ${this.config.token}`;
        }

        const res = await fetch(url, { headers });
        if (!res.ok) {
            const body = await res.text();
            return { error: `HTTP ${res.status}: ${body}` };
        }

        const data = await res.json();
        return {
            totalCount: data.total_count || 0,
            results: (data.items || []).map(item => formatItem(type, item)),
        };
    }
}

module.exports = GitHubProvider;
