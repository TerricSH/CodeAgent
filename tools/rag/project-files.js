const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
    'node_modules',
    '.git',
    '.code',
    'workspace',
]);

const DEFAULT_EXTENSIONS = Object.freeze([
    '.js',
    '.json',
    '.md',
    '.py',
    '.sql',
    '.yml',
    '.yaml',
]);

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeExtensions(values) {
    const source = Array.isArray(values) && values.length > 0 ? values : DEFAULT_EXTENSIONS;
    return new Set(source.map((value) => {
        const extension = String(value || '').trim().toLowerCase();
        if (!extension) throw new Error('Project file extension cannot be empty');
        return extension.startsWith('.') ? extension : `.${extension}`;
    }));
}

function listProjectFiles(root, options = {}) {
    const canonicalRoot = fs.realpathSync(root);
    const extensions = normalizeExtensions(options.extensions);
    const excludedDirectories = new Set([
        ...DEFAULT_EXCLUDED_DIRECTORIES,
        ...(Array.isArray(options.excludeDirectories) ? options.excludeDirectories : []),
    ].map(value => String(value).trim()).filter(Boolean));
    const maxFiles = positiveInteger(options.maxFiles, 5000);
    const maxFileBytes = positiveInteger(options.maxFileBytes, 2 * 1024 * 1024);
    const files = [];
    const pending = [{ absolute: canonicalRoot, relative: '' }];

    while (pending.length > 0) {
        const directory = pending.pop();
        const entries = fs.readdirSync(directory.absolute, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const relative = directory.relative
                ? path.join(directory.relative, entry.name)
                : entry.name;
            const absolute = path.join(directory.absolute, entry.name);

            if (entry.isDirectory()) {
                if (!excludedDirectories.has(entry.name)) {
                    pending.push({ absolute, relative });
                }
                continue;
            }
            if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;

            const stat = fs.statSync(absolute);
            if (stat.size > maxFileBytes) continue;
            files.push({
                path: relative.split(path.sep).join('/'),
                size: stat.size,
            });
            if (files.length > maxFiles) {
                throw new Error(`Project source scan exceeds ${maxFiles} files`);
            }
        }
    }

    return files.sort((left, right) => left.path.localeCompare(right.path));
}

module.exports = {
    DEFAULT_EXCLUDED_DIRECTORIES,
    DEFAULT_EXTENSIONS,
    listProjectFiles,
};
