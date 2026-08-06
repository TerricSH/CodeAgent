function toFiniteVector(value, label = 'embedding') {
    if (!Array.isArray(value) && !(value instanceof Float32Array)) {
        throw new TypeError(`${label} must be an array of numbers`);
    }
    if (value.length === 0) throw new Error(`${label} must not be empty`);
    const vector = Float32Array.from(value);
    for (const number of vector) {
        if (!Number.isFinite(number)) throw new Error(`${label} contains a non-finite value`);
    }
    return vector;
}

function normalizeVector(value, label) {
    const vector = toFiniteVector(value, label);
    let sum = 0;
    for (const number of vector) sum += number * number;
    const norm = Math.sqrt(sum);
    if (norm === 0) throw new Error(`${label || 'embedding'} has zero magnitude`);
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
    return vector;
}

function dotProduct(left, right) {
    if (left.length !== right.length) return null;
    let score = 0;
    for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
    return score;
}

module.exports = {
    toFiniteVector,
    normalizeVector,
    dotProduct,
};
