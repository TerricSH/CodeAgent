function keywordTerms(value) {
    const text = String(value || '').normalize('NFKC').toLowerCase();
    const terms = new Set();
    for (const match of text.matchAll(/[a-z0-9_][a-z0-9_.:-]{1,63}/g)) {
        terms.add(match[0].replace(/[^a-z0-9_]+/g, '_'));
    }
    const cjkRuns = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
    for (const run of cjkRuns) {
        for (const character of run) terms.add(character);
        for (let index = 0; index < run.length - 1; index += 1) {
            terms.add(run.slice(index, index + 2));
        }
    }
    return [...terms].slice(0, 2048);
}

function keywordText(value) {
    return keywordTerms(value).join(' ');
}

function postgresTsQuery(value) {
    return keywordTerms(value)
        .map(term => term.replace(/[^a-z0-9_\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ''))
        .filter(Boolean)
        .slice(0, 64)
        .join(' | ');
}

module.exports = { keywordTerms, keywordText, postgresTsQuery };
