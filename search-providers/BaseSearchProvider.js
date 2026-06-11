class BaseSearchProvider {
    constructor(config) {
        this.config = config;
    }

    async search(query, maxResults) {
        throw new Error('子类必须实现 search 方法');
    }
}

module.exports = BaseSearchProvider;
