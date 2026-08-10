const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PatchError } = require('./parser');

function fail(code, message, details) {
    throw new PatchError(code, message, details);
}

function digest(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeUtf8(buffer, filePath) {
    const content = buffer.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(buffer)) {
        fail('PATCH_ENCODING_INVALID', `文件不是有效的 UTF-8 文本: ${filePath}`, { path: filePath });
    }
    return content;
}

function splitText(content) {
    const bom = content.startsWith('\ufeff') ? '\ufeff' : '';
    const body = bom ? content.slice(1) : content;
    const eol = body.match(/\r\n|\n|\r/)?.[0] || '\n';
    const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(body);
    const normalized = body.replace(/\r\n?/g, '\n');
    let lines = body === '' ? [] : normalized.split('\n');
    if (hasFinalNewline) lines = lines.slice(0, -1);
    return { bom, eol, hasFinalNewline, lines };
}

function joinText(state) {
    let body = state.lines.join(state.eol);
    if (state.hasFinalNewline && state.lines.length > 0) body += state.eol;
    return state.bom + body;
}

function sequenceMatches(lines, expected, position) {
    if (position < 0 || position + expected.length > lines.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
        if (lines[position + index] !== expected[index]) return false;
    }
    return true;
}

function findMatches(lines, expected, startAt) {
    const matches = [];
    for (let position = Math.max(0, startAt); position <= lines.length - expected.length; position += 1) {
        if (sequenceMatches(lines, expected, position)) matches.push(position);
    }
    return matches;
}

function resolveHunkPosition(state, hunk, filePath, hunkNumber, lineDelta, minimumPosition) {
    const oldLines = hunk.lines.filter(line => line.kind !== 'add').map(line => line.text);

    if (oldLines.length === 0) {
        if (hunk.oldStart === null) {
            fail(
                'PATCH_CONTEXT_AMBIGUOUS',
                `文件 ${filePath} 的第 ${hunkNumber} 个纯新增 hunk 必须提供行号范围`,
                { path: filePath, hunk: hunkNumber }
            );
        }
        const position = hunk.oldStart + lineDelta;
        if (position < minimumPosition || position > state.lines.length) {
            fail(
                'PATCH_CONTEXT_MISMATCH',
                `文件 ${filePath} 的第 ${hunkNumber} 个 hunk 插入位置超出范围`,
                { path: filePath, hunk: hunkNumber }
            );
        }
        return { position, oldLines };
    }

    const expectedPosition = hunk.oldStart === null
        ? null
        : hunk.oldStart - 1 + lineDelta;
    if (
        expectedPosition !== null
        && expectedPosition >= minimumPosition
        && sequenceMatches(state.lines, oldLines, expectedPosition)
    ) {
        return { position: expectedPosition, oldLines };
    }

    const matches = findMatches(state.lines, oldLines, minimumPosition);
    if (matches.length === 0) {
        fail(
            'PATCH_CONTEXT_MISMATCH',
            `文件 ${filePath} 的第 ${hunkNumber} 个 hunk 找不到匹配上下文`,
            { path: filePath, hunk: hunkNumber }
        );
    }
    if (matches.length > 1) {
        fail(
            'PATCH_CONTEXT_AMBIGUOUS',
            `文件 ${filePath} 的第 ${hunkNumber} 个 hunk 上下文匹配不唯一`,
            { path: filePath, hunk: hunkNumber, matches: matches.length }
        );
    }
    return { position: matches[0], oldLines };
}

function applyHunks(content, hunks, filePath) {
    const state = splitText(content);
    let lineDelta = 0;
    let minimumPosition = 0;

    for (let index = 0; index < hunks.length; index += 1) {
        const hunk = hunks[index];
        const hunkNumber = index + 1;
        const { position, oldLines } = resolveHunkPosition(
            state,
            hunk,
            filePath,
            hunkNumber,
            lineDelta,
            minimumPosition
        );
        const newLines = hunk.lines.filter(line => line.kind !== 'delete').map(line => line.text);
        const touchesEnd = position + oldLines.length === state.lines.length;

        state.lines.splice(position, oldLines.length, ...newLines);
        if (touchesEnd) {
            state.hasFinalNewline = state.lines.length > 0 && !hunk.newEndsWithoutNewline;
        }
        lineDelta += newLines.length - oldLines.length;
        minimumPosition = position + newLines.length;
    }

    return joinText(state);
}

function pathKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAncestor(ancestor, candidate) {
    const relative = path.relative(ancestor, candidate);
    return Boolean(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function assertNoPathConflicts(changes) {
    const seen = new Map();
    for (const change of changes) {
        const key = pathKey(change.target);
        if (seen.has(key)) {
            fail(
                'PATCH_PATH_CONFLICT',
                `同一事务不能多次操作同一文件: ${change.operation.path}`,
                { path: change.operation.path, conflictsWith: seen.get(key) }
            );
        }
        seen.set(key, change.operation.path);
    }

    for (let left = 0; left < changes.length; left += 1) {
        for (let right = left + 1; right < changes.length; right += 1) {
            const first = changes[left];
            const second = changes[right];
            if (isAncestor(first.target, second.target) || isAncestor(second.target, first.target)) {
                fail(
                    'PATCH_PATH_CONFLICT',
                    `文件路径不能互为父子路径: ${first.operation.path}, ${second.operation.path}`,
                    { paths: [first.operation.path, second.operation.path] }
                );
            }
        }
    }
}

function prepareChanges(operations, fileSystem, options = {}) {
    const fileOps = options.fileOps || fs;
    const changes = operations.map((operation) => {
        const target = fileSystem.resolveForWrite(operation.path);
        const exists = fileOps.existsSync(target);

        if (operation.action === 'add' && exists) {
            fail('PATCH_TARGET_EXISTS', `新增文件已存在: ${operation.path}`, { path: operation.path });
        }
        if (operation.action !== 'add' && !exists) {
            fail('PATCH_TARGET_MISSING', `目标文件不存在: ${operation.path}`, { path: operation.path });
        }

        let beforeBuffer = null;
        let beforeContent = null;
        let mode = null;
        if (exists) {
            const stat = fileOps.statSync(target);
            if (!stat.isFile()) {
                fail('PATCH_TARGET_NOT_FILE', `目标路径不是文件: ${operation.path}`, { path: operation.path });
            }
            mode = stat.mode & 0o777;
            beforeBuffer = fileOps.readFileSync(target);
            beforeContent = decodeUtf8(beforeBuffer, operation.path);
        }

        let afterContent = null;
        if (operation.action === 'add') afterContent = operation.content;
        if (operation.action === 'update') {
            afterContent = applyHunks(beforeContent, operation.hunks, operation.path);
        }

        const afterBuffer = afterContent === null ? null : Buffer.from(afterContent, 'utf8');
        return {
            operation,
            target,
            displayPath: fileSystem.relative(target),
            beforeBuffer,
            beforeDigest: beforeBuffer && digest(beforeBuffer),
            afterBuffer,
            afterDigest: afterBuffer && digest(afterBuffer),
            mode,
        };
    });

    assertNoPathConflicts(changes);
    return changes;
}

function ensureParentDirectory(filePath, fileOps, createdDirectories, createdSet) {
    let cursor = path.dirname(filePath);
    const missing = [];
    while (!fileOps.existsSync(cursor)) {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('PATCH_STAGE_FAILED', `无法创建补丁暂存目录: ${cursor}`);
        cursor = parent;
    }
    if (!fileOps.statSync(cursor).isDirectory()) {
        fail('PATCH_STAGE_FAILED', `补丁目标的父路径不是目录: ${cursor}`);
    }

    for (const directory of missing.reverse()) {
        try {
            fileOps.mkdirSync(directory);
            const key = pathKey(directory);
            if (!createdSet.has(key)) {
                createdSet.add(key);
                createdDirectories.push(directory);
            }
        } catch (error) {
            if (!fileOps.existsSync(directory) || !fileOps.statSync(directory).isDirectory()) throw error;
        }
    }
}

function artifactPaths(target, transactionId, index) {
    const parent = path.dirname(target);
    const prefix = `.codeagent-patch-${transactionId}-${index}`;
    return {
        stagePath: path.join(parent, `${prefix}.stage`),
        backupPath: path.join(parent, `${prefix}.backup`),
    };
}

function cleanupFile(fileOps, filePath, warnings) {
    try {
        if (fileOps.existsSync(filePath)) fileOps.unlinkSync(filePath);
    } catch (error) {
        warnings.push(`${filePath}: ${error.message}`);
    }
}

function cleanupDirectories(fileOps, directories, warnings) {
    for (const directory of [...directories].reverse()) {
        try {
            if (fileOps.existsSync(directory)) fileOps.rmdirSync(directory);
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
                warnings.push(`${directory}: ${error.message}`);
            }
        }
    }
}

function cleanupPrepared(fileOps, artifacts, createdDirectories) {
    const warnings = [];
    for (const artifact of artifacts) {
        if (!artifact.stagePromoted) cleanupFile(fileOps, artifact.stagePath, warnings);
        if (!artifact.originalMoved) cleanupFile(fileOps, artifact.backupPath, warnings);
    }
    cleanupDirectories(fileOps, createdDirectories, warnings);
    return warnings;
}

function attachTransaction(error, fallbackCode, fallbackMessage, transaction, options = {}) {
    const wrapped = error instanceof PatchError
        ? error
        : new PatchError(fallbackCode, `${fallbackMessage}: ${error.message}`, { cause: error.message });
    if (options.overrideCode) wrapped.code = fallbackCode;
    wrapped.transaction = transaction;
    return wrapped;
}

function verifyUnchanged(artifact, fileOps) {
    const { change } = artifact;
    if (change.beforeBuffer) {
        if (!fileOps.existsSync(change.target) || !fileOps.statSync(change.target).isFile()) {
            fail(
                'PATCH_CONCURRENT_MODIFICATION',
                `文件在补丁提交前发生变化: ${change.operation.path}`,
                { path: change.operation.path }
            );
        }
        const current = fileOps.readFileSync(change.target);
        if (digest(current) !== change.beforeDigest) {
            fail(
                'PATCH_CONCURRENT_MODIFICATION',
                `文件在补丁提交前发生变化: ${change.operation.path}`,
                { path: change.operation.path }
            );
        }
    } else if (fileOps.existsSync(change.target)) {
        fail(
            'PATCH_CONCURRENT_MODIFICATION',
            `新增文件在补丁提交前已出现: ${change.operation.path}`,
            { path: change.operation.path }
        );
    }

    if (change.afterBuffer) {
        if (!fileOps.existsSync(artifact.stagePath)) {
            fail('PATCH_STAGE_FAILED', `补丁暂存文件丢失: ${change.operation.path}`);
        }
        const staged = fileOps.readFileSync(artifact.stagePath);
        if (digest(staged) !== change.afterDigest) {
            fail('PATCH_STAGE_FAILED', `补丁暂存文件内容发生变化: ${change.operation.path}`);
        }
    }
}

function rollback(fileOps, artifacts) {
    const errors = [];
    for (const artifact of [...artifacts].reverse()) {
        try {
            if (artifact.stagePromoted) {
                fileOps.renameSync(artifact.change.target, artifact.stagePath);
                artifact.stagePromoted = false;
            }
        } catch (error) {
            errors.push(`${artifact.change.operation.path}（移除新版本）: ${error.message}`);
        }
        try {
            if (artifact.originalMoved) {
                fileOps.renameSync(artifact.backupPath, artifact.change.target);
                artifact.originalMoved = false;
            }
        } catch (error) {
            errors.push(`${artifact.change.operation.path}（恢复原版本）: ${error.message}`);
        }
    }
    return errors;
}

function normalizeTransactionId(value) {
    const normalized = String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    return normalized || crypto.randomBytes(8).toString('hex');
}

function applyFileTransaction(changes, options = {}) {
    const fileOps = options.fileOps || fs;
    const transactionId = normalizeTransactionId(
        typeof options.transactionId === 'function' ? options.transactionId() : options.transactionId
    );
    const artifacts = [];
    const createdDirectories = [];
    const createdSet = new Set();

    try {
        for (let index = 0; index < changes.length; index += 1) {
            const change = changes[index];
            ensureParentDirectory(change.target, fileOps, createdDirectories, createdSet);
            const paths = artifactPaths(change.target, transactionId, index);
            if (fileOps.existsSync(paths.stagePath) || fileOps.existsSync(paths.backupPath)) {
                fail('PATCH_STAGE_FAILED', `补丁暂存路径冲突: ${change.operation.path}`);
            }
            const artifact = {
                change,
                ...paths,
                originalMoved: false,
                stagePromoted: false,
            };
            artifacts.push(artifact);

            if (change.afterBuffer) {
                const writeOptions = { flag: 'wx' };
                if (change.mode !== null) writeOptions.mode = change.mode;
                fileOps.writeFileSync(artifact.stagePath, change.afterBuffer, writeOptions);
            }
        }

        for (const artifact of artifacts) verifyUnchanged(artifact, fileOps);
    } catch (error) {
        const cleanupWarnings = cleanupPrepared(fileOps, artifacts, createdDirectories);
        throw attachTransaction(error, 'PATCH_STAGE_FAILED', '补丁暂存失败', {
            committed: false,
            rolledBack: false,
            unchanged: true,
            phase: 'prepare',
            cleanupWarnings,
        });
    }

    try {
        for (const artifact of artifacts) {
            const { change } = artifact;
            if (change.beforeBuffer) {
                fileOps.renameSync(change.target, artifact.backupPath);
                artifact.originalMoved = true;
            }
            if (change.afterBuffer) {
                fileOps.renameSync(artifact.stagePath, change.target);
                artifact.stagePromoted = true;
            }
        }
    } catch (error) {
        const rollbackErrors = rollback(fileOps, artifacts);
        const cleanupWarnings = cleanupPrepared(fileOps, artifacts, createdDirectories);
        const rolledBack = rollbackErrors.length === 0;
        throw attachTransaction(
            error,
            rolledBack ? 'PATCH_COMMIT_FAILED' : 'PATCH_ROLLBACK_FAILED',
            rolledBack ? '补丁提交失败，已回滚' : '补丁提交及回滚失败',
            {
                committed: false,
                rolledBack,
                unchanged: rolledBack,
                phase: 'commit',
                rollbackErrors,
                cleanupWarnings,
            },
            { overrideCode: true }
        );
    }

    const cleanupWarnings = [];
    for (const artifact of artifacts) cleanupFile(fileOps, artifact.backupPath, cleanupWarnings);
    return {
        transactionId,
        committed: true,
        rolledBack: false,
        unchanged: false,
        cleanupWarnings,
    };
}

module.exports = {
    applyFileTransaction,
    applyHunks,
    prepareChanges,
};
