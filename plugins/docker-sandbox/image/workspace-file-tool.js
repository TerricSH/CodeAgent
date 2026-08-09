const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function pathIsInside(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeProtectedPath(value) {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
        throw new Error('保护路径必须是非空相对路径');
    }
    const normalized = path.normalize(value.trim());
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error('保护路径越过了工作区边界');
    }
    return normalized.split(path.sep).join('/');
}

function resolveWorkspaceFile(workspace, relativePath, protectedPaths, allowProtected) {
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
        throw new Error('工作区文件路径不能为空');
    }
    let requestedPath = relativePath.trim();
    if (requestedPath.startsWith('/') && !requestedPath.startsWith('//')) {
        requestedPath = requestedPath.slice(1);
    }
    if (!requestedPath || path.isAbsolute(requestedPath)) {
        throw new Error('工作区文件路径必须位于工作区虚拟根目录内');
    }
    const workspaceRoot = fs.realpathSync(path.resolve(workspace));
    const normalized = path.normalize(requestedPath);
    const target = path.resolve(workspaceRoot, normalized);
    if (!pathIsInside(workspaceRoot, target)) throw new Error('工作区文件路径越过了根目录');
    const portable = path.relative(workspaceRoot, target).split(path.sep).join('/');
    if (!allowProtected) {
        for (const protectedPath of protectedPaths.map(normalizeProtectedPath)) {
            if (portable === protectedPath || portable.startsWith(`${protectedPath}/`)) {
                throw new Error(`工作区文件受保护：${portable}`);
            }
        }
    }
    let current = path.dirname(target);
    while (pathIsInside(workspaceRoot, current) && current !== workspaceRoot) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`工作区路径包含符号链接：${portable}`);
        }
        current = path.dirname(current);
    }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`工作区文件是符号链接：${portable}`);
    }
    return { target, portable };
}

function atomicWriteFile(target, content) {
    const directory = path.dirname(target);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        throw new Error('工作区文件的父目录不存在');
    }
    const suffix = crypto.randomUUID();
    const temporary = path.join(directory, `.workspace-write-${suffix}.tmp`);
    const backup = path.join(directory, `.workspace-write-${suffix}.bak`);
    let backedUp = false;
    fs.writeFileSync(temporary, content, 'utf8');
    try {
        if (fs.existsSync(target)) {
            fs.renameSync(target, backup);
            backedUp = true;
        }
        fs.renameSync(temporary, target);
        if (backedUp) fs.rmSync(backup, { force: true });
    } catch (error) {
        if (!fs.existsSync(target) && backedUp && fs.existsSync(backup)) {
            fs.renameSync(backup, target);
        }
        throw error;
    } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
        if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
    }
}

function jsonPointerSegments(pointer) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 1000) {
        throw new Error('JSON 更新指针必须以 / 开头');
    }
    return pointer.slice(1).split('/').map(segment => segment
        .replace(/~1/g, '/')
        .replace(/~0/g, '~'));
}

function applyJsonUpdates(document, updates) {
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > 12) {
        throw new Error('updates 必须包含 1 至 12 个 JSON 指针更新');
    }
    for (const update of updates) {
        if (!update || typeof update !== 'object' || !Object.hasOwn(update, 'value')) {
            throw new Error('每项 JSON 更新都必须包含 pointer 和 value');
        }
        const segments = jsonPointerSegments(update.pointer);
        let parent = document;
        for (const segment of segments.slice(0, -1)) {
            if (UNSAFE_POINTER_SEGMENTS.has(segment)) throw new Error('JSON 指针包含不安全字段');
            if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) {
                throw new Error(`JSON 指针不存在：${update.pointer}`);
            }
            parent = parent[segment];
        }
        const finalSegment = segments.at(-1);
        if (UNSAFE_POINTER_SEGMENTS.has(finalSegment)) throw new Error('JSON 指针包含不安全字段');
        if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, finalSegment)) {
            throw new Error(`JSON 指针不存在：${update.pointer}`);
        }
        const currentValue = parent[finalSegment];
        if (currentValue !== null && typeof currentValue === 'object') {
            throw new Error(`JSON 指针必须指向已有的标量叶节点：${update.pointer}`);
        }
        parent[finalSegment] = update.value;
    }
    return document;
}

function executeOperation(workspace, request) {
    const operation = request && request.operation;
    const args = request && request.args && typeof request.args === 'object' ? request.args : {};
    const protectedPaths = Array.isArray(request && request.protectedPaths)
        ? request.protectedPaths
        : [];
    const file = resolveWorkspaceFile(
        workspace,
        args.path,
        protectedPaths,
        operation === 'sandbox_read_file'
    );
    if (operation === 'sandbox_read_file') {
        if (!fs.existsSync(file.target) || !fs.statSync(file.target).isFile()) {
            throw new Error(`工作区文件不存在：${file.portable}`);
        }
        if (fs.statSync(file.target).size > MAX_FILE_BYTES) {
            throw new Error('工作区文件超过 1 MiB 读取限制');
        }
        return { ok: true, path: file.portable, content: fs.readFileSync(file.target, 'utf8') };
    }
    if (operation === 'sandbox_write_file') {
        if (typeof args.content !== 'string') throw new Error('content 必须是字符串');
        if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) {
            throw new Error('工作区文件超过 1 MiB 写入限制');
        }
        atomicWriteFile(file.target, args.content);
        return {
            ok: true,
            path: file.portable,
            bytes: Buffer.byteLength(args.content, 'utf8'),
        };
    }
    if (operation === 'sandbox_edit_json') {
        if (!fs.existsSync(file.target) || !fs.statSync(file.target).isFile()) {
            throw new Error(`工作区 JSON 文件不存在：${file.portable}`);
        }
        const document = JSON.parse(fs.readFileSync(file.target, 'utf8'));
        const updated = applyJsonUpdates(document, args.updates);
        const content = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
            throw new Error('更新后的 JSON 超过 1 MiB 写入限制');
        }
        atomicWriteFile(file.target, content);
        return {
            ok: true,
            path: file.portable,
            updates: args.updates.length,
            bytes: Buffer.byteLength(content, 'utf8'),
        };
    }
    throw new Error(`不支持的工作区操作：${operation}`);
}

async function main() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) throw new Error('工作区操作请求超过 2 MiB 限制');
        chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return executeOperation('/workspace', request);
}

if (require.main === module) {
    main()
        .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch(error => {
            process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
            process.exitCode = 1;
        });
}

module.exports = {
    MAX_FILE_BYTES,
    MAX_REQUEST_BYTES,
    resolveWorkspaceFile,
    atomicWriteFile,
    applyJsonUpdates,
    executeOperation,
};
