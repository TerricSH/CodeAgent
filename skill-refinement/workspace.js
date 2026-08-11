const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathIsInside, ensureContainedDirectory } = require('../sandbox/workspace');

const SNAPSHOT_IGNORES = new Set(['.git', '.code', 'node_modules']);
const SNAPSHOT_SECRET_PATHS = new Set([
    'github/config.json',
    'model-providers/config.json',
    'search-providers/config.json',
]);
const SNAPSHOT_PRIVATE_PATHS = Object.freeze(['skill-refinement/suites']);
const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

function copySnapshot(source, destination, options = {}) {
    const sourceRoot = fs.realpathSync(path.resolve(source));
    fs.mkdirSync(destination, { recursive: true });
    let files = 0;
    let bytes = 0;
    const privatePaths = new Set(SNAPSHOT_PRIVATE_PATHS);
    for (const candidate of options.excludePaths || []) {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const realCandidate = fs.realpathSync(path.resolve(candidate));
        if (!pathIsInside(sourceRoot, realCandidate)) continue;
        const relative = path.relative(sourceRoot, realCandidate).split(path.sep).join('/');
        if (relative) privatePaths.add(relative);
    }

    function ignored(relative, depth, name) {
        const portable = relative.split(path.sep).join('/');
        if (depth === 0 && SNAPSHOT_IGNORES.has(name)) return true;
        if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') return true;
        if ([...privatePaths].some(privatePath => (
            portable === privatePath || portable.startsWith(`${privatePath}/`)
        ))) return true;
        return SNAPSHOT_SECRET_PATHS.has(portable);
    }

    function visit(current, target, depth) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`Skill Refinement snapshots do not allow symbolic links: ${current}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(sourceRoot, real)) {
            throw new Error(`Skill Refinement snapshot source escaped its root: ${current}`);
        }
        if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const relative = path.relative(sourceRoot, path.join(current, entry.name));
                if (ignored(relative, depth, entry.name)) continue;
                visit(path.join(current, entry.name), path.join(target, entry.name), depth + 1);
            }
            return;
        }
        if (!stat.isFile()) throw new Error(`Unsupported snapshot entry: ${current}`);
        files += 1;
        bytes += stat.size;
        if (files > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
            throw new Error('Skill Refinement snapshot exceeded its file or byte limit');
        }
        fs.copyFileSync(current, target);
    }

    visit(sourceRoot, destination, 0);
    return { files, bytes };
}

function fileHash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function scanTree(root) {
    const entries = new Map();
    if (!fs.existsSync(root)) return entries;
    const realRoot = fs.realpathSync(path.resolve(root));

    function visit(current, relative, depth) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`Skill Refinement workspaces do not allow symbolic links: ${relative || '.'}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(realRoot, real)) {
            throw new Error(`Skill Refinement workspace entry escaped its root: ${relative || '.'}`);
        }
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(current, { withFileTypes: true })) {
                if (depth === 0 && SNAPSHOT_IGNORES.has(child.name)) continue;
                const childRelative = relative ? path.join(relative, child.name) : child.name;
                visit(path.join(current, child.name), childRelative, depth + 1);
            }
            return;
        }
        if (!stat.isFile()) throw new Error(`Unsupported workspace entry: ${relative}`);
        entries.set(relative.split(path.sep).join('/'), {
            hash: fileHash(current),
            bytes: stat.size,
        });
    }

    visit(realRoot, '', 0);
    return entries;
}

function diffTrees(baseline, workspace) {
    const before = scanTree(baseline);
    const after = scanTree(workspace);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const files = [];
    let changedBytes = 0;
    for (const name of names) {
        const left = before.get(name) || null;
        const right = after.get(name) || null;
        if (left && right && left.hash === right.hash) continue;
        const status = !left ? 'added' : (!right ? 'deleted' : 'modified');
        changedBytes += Math.max(left ? left.bytes : 0, right ? right.bytes : 0);
        files.push({
            path: name,
            status,
            beforeHash: left ? left.hash : null,
            afterHash: right ? right.hash : null,
            beforeBytes: left ? left.bytes : 0,
            afterBytes: right ? right.bytes : 0,
        });
    }
    return { files, fileCount: files.length, changedBytes };
}

function entityDigest(root, relative) {
    const target = path.resolve(root, relative);
    const resolvedRoot = path.resolve(root);
    if (!pathIsInside(resolvedRoot, target)) throw new Error('Protected path escaped the project');
    if (!fs.existsSync(target)) return null;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { type: 'symlink' };
    if (stat.isFile()) return { type: 'file', hash: fileHash(target), bytes: stat.size };
    if (!stat.isDirectory()) return { type: 'unsupported' };
    const entries = [...scanTree(target).entries()];
    return {
        type: 'directory',
        hash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
        files: entries.length,
    };
}

function protectedViolations(baseline, workspace, protectedPaths) {
    const violations = [];
    for (const relative of protectedPaths) {
        const before = entityDigest(baseline, relative);
        const after = entityDigest(workspace, relative);
        if (JSON.stringify(before) !== JSON.stringify(after)) violations.push(relative);
    }
    return violations;
}

module.exports = {
    pathIsInside,
    ensureContainedDirectory,
    copySnapshot,
    scanTree,
    diffTrees,
    protectedViolations,
    SNAPSHOT_PRIVATE_PATHS,
};
