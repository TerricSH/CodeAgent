function candidateKey(candidate) {
    return `${candidate.documentId}:${candidate.chunkIndex}`;
}

function reciprocalRankFusion(lists = [], options = {}) {
    const rankConstant = Number.isFinite(options.rankConstant) ? options.rankConstant : 60;
    const weights = Array.isArray(options.weights) ? options.weights : [];
    const fused = new Map();
    lists.forEach((list, listIndex) => {
        const weight = Number.isFinite(weights[listIndex]) ? weights[listIndex] : 1;
        (list || []).forEach((candidate, rank) => {
            const key = candidateKey(candidate);
            const current = fused.get(key) || { ...candidate, fusedScore: 0, retrieval: [] };
            Object.assign(current, candidate);
            current.fusedScore += weight / (rankConstant + rank + 1);
            current.retrieval.push({ source: listIndex, rank: rank + 1 });
            fused.set(key, current);
        });
    });
    return [...fused.values()].sort((left, right) => right.fusedScore - left.fusedScore);
}

module.exports = { candidateKey, reciprocalRankFusion };
