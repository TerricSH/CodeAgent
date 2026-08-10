const fs = require('node:fs');
const path = require('node:path');

function pathIsInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
}

function realPath(value) {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function ensureContainedDirectory(root, candidate, label = 'Sandbox directory') {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    fs.mkdirSync(resolvedRoot, { recursive: true });
    const realRoot = realPath(resolvedRoot);

    if (!pathIsInside(resolvedRoot, resolvedCandidate)) {
        throw new Error(`${label} escaped its configured root`);
    }

    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (!relative) return realRoot;

    let current = resolvedRoot;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) fs.mkdirSync(current);

        const realCurrent = realPath(current);
        if (!pathIsInside(realRoot, realCurrent)) {
            throw new Error(`${label} escaped its configured root`);
        }
        if (!fs.statSync(realCurrent).isDirectory()) {
            throw new Error(`${label} is not a directory`);
        }
    }

    return realPath(resolvedCandidate);
}

module.exports = { pathIsInside, ensureContainedDirectory };
