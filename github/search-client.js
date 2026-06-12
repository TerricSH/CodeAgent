const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
    apiBaseUrl: 'https://api.github.com',
    token: '',
    perPage: 5,
};

function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...config };
}

function endpointFor(type) {
    const endpoints = {
        repositories: 'repositories',
        code: 'code',
        issues: 'issues',
        users: 'users',
    };
    return endpoints[type] || endpoints.repositories;
}

function formatItem(type, item) {
    if (type === 'repositories') {
        return {
            title: item.full_name,
            url: item.html_url,
            content: item.description || '',
        };
    }

    if (type === 'code') {
        return {
            title: `${item.repository?.full_name || ''}/${item.path}`,
            url: item.html_url,
            content: `file: ${item.name}`,
        };
    }

    if (type === 'issues') {
        return {
            title: item.title,
            url: item.html_url,
            content: `${item.state} #${item.number}`,
        };
    }

    if (type === 'users') {
        return {
            title: item.login,
            url: item.html_url,
            content: item.type || '',
        };
    }

    return {
        title: item.name || item.full_name || item.login || item.title || item.url,
        url: item.html_url || item.url,
        content: item.description || item.type || '',
    };
}

async function search({ query, type = 'repositories', maxResults }) {
    const config = loadConfig();
    const perPage = maxResults || config.perPage || DEFAULT_CONFIG.perPage;
    const endpoint = endpointFor(type);
    const url = new URL(`/search/${endpoint}`, config.apiBaseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', perPage);

    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CodeAgent',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const body = await res.text();
        return { error: `HTTP ${res.status}: ${body}` };
    }

    const data = await res.json();
    return {
        totalCount: data.total_count || 0,
        results: (data.items || []).map((item) => formatItem(type, item)),
    };
}

module.exports = { search };
