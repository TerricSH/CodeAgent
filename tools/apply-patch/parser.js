class PatchError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PatchError';
        this.code = code;
        this.details = details;
    }
}

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const NO_NEWLINE = '\\ No newline at end of file';
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

function fail(code, message, details) {
    throw new PatchError(code, message, details);
}

function parsePath(value, lineNumber) {
    const filePath = String(value || '').trim();
    if (!filePath) fail('INVALID_PATCH', `补丁第 ${lineNumber} 行缺少文件路径`);
    if (filePath.includes('\0')) fail('INVALID_PATCH', `补丁第 ${lineNumber} 行的路径包含空字节`);
    return filePath;
}

function parseAddBody(body, filePath) {
    const content = [];
    let finalNewline = body.length > 0;
    let previousWasContent = false;

    for (let index = 0; index < body.length; index += 1) {
        const line = body[index];
        if (line === NO_NEWLINE) {
            if (!previousWasContent || index !== body.length - 1) {
                fail('INVALID_PATCH', `新增文件 ${filePath} 的无换行标记位置无效`);
            }
            finalNewline = false;
            previousWasContent = false;
            continue;
        }
        if (!line.startsWith('+')) {
            fail('INVALID_PATCH', `新增文件 ${filePath} 的内容行必须以 + 开头`);
        }
        content.push(line.slice(1));
        previousWasContent = true;
    }

    return content.join('\n') + (content.length > 0 && finalNewline ? '\n' : '');
}

function parseRange(header, filePath) {
    if (header === '@@') {
        return { oldStart: null, oldCount: null, newStart: null, newCount: null };
    }

    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
    if (match) {
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        if ((oldStart === 0 && oldCount !== 0) || (newStart === 0 && newCount !== 0)) {
            fail('INVALID_PATCH', `更新文件 ${filePath} 的 hunk 行号范围无效: ${header}`);
        }
        return { oldStart, oldCount, newStart, newCount };
    }

    if (header.startsWith('@@ -')) {
        fail('INVALID_PATCH', `更新文件 ${filePath} 的 hunk 头格式无效: ${header}`);
    }
    if (header.startsWith('@@ ')) {
        return { oldStart: null, oldCount: null, newStart: null, newCount: null };
    }
    fail('INVALID_PATCH', `更新文件 ${filePath} 的 hunk 头格式无效: ${header}`);
}

function parseHunk(header, body, filePath) {
    const range = parseRange(header, filePath);
    const lines = [];
    let previous = null;

    for (const rawLine of body) {
        if (rawLine === NO_NEWLINE) {
            if (!previous || previous.noNewline) {
                fail('INVALID_PATCH', `更新文件 ${filePath} 的无换行标记位置无效`);
            }
            previous.noNewline = true;
            continue;
        }

        const prefix = rawLine[0];
        const kind = prefix === ' ' ? 'context' : prefix === '+' ? 'add' : prefix === '-' ? 'delete' : null;
        if (!kind) {
            fail('INVALID_PATCH', `更新文件 ${filePath} 的 hunk 内容行必须以空格、+ 或 - 开头`);
        }
        previous = { kind, text: rawLine.slice(1), noNewline: false };
        lines.push(previous);
    }

    if (lines.length === 0 || !lines.some(line => line.kind === 'add' || line.kind === 'delete')) {
        fail('INVALID_PATCH', `更新文件 ${filePath} 的每个 hunk 至少需要一处增删`);
    }

    const oldLines = lines.filter(line => line.kind !== 'add');
    const newLines = lines.filter(line => line.kind !== 'delete');
    if (range.oldCount !== null && range.oldCount !== oldLines.length) {
        fail(
            'INVALID_PATCH',
            `更新文件 ${filePath} 的旧行数声明为 ${range.oldCount}，实际为 ${oldLines.length}`
        );
    }
    if (range.newCount !== null && range.newCount !== newLines.length) {
        fail(
            'INVALID_PATCH',
            `更新文件 ${filePath} 的新行数声明为 ${range.newCount}，实际为 ${newLines.length}`
        );
    }

    return {
        ...range,
        lines,
        oldEndsWithoutNewline: Boolean(oldLines.at(-1)?.noNewline),
        newEndsWithoutNewline: Boolean(newLines.at(-1)?.noNewline),
    };
}

function parseUpdateBody(body, filePath) {
    const hunks = [];
    let index = 0;

    while (index < body.length) {
        const header = body[index];
        if (!header.startsWith('@@')) {
            fail('INVALID_PATCH', `更新文件 ${filePath} 必须以 @@ hunk 开始`);
        }
        index += 1;
        const hunkBody = [];
        while (index < body.length && !body[index].startsWith('@@')) {
            hunkBody.push(body[index]);
            index += 1;
        }
        hunks.push(parseHunk(header, hunkBody, filePath));
    }

    if (hunks.length === 0) fail('INVALID_PATCH', `更新文件 ${filePath} 至少需要一个 hunk`);
    return hunks;
}

function parsePatch(patch) {
    if (typeof patch !== 'string' || patch.trim() === '') {
        fail('INVALID_PATCH', 'patch 必须是非空字符串');
    }

    const normalized = patch.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (lines[0]?.charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
    while (lines.at(-1) === '') lines.pop();

    if (lines[0] !== BEGIN_PATCH) fail('INVALID_PATCH', `patch 必须以 ${BEGIN_PATCH} 开头`);
    const endIndex = lines.indexOf(END_PATCH);
    if (endIndex < 0) fail('INVALID_PATCH', `patch 必须以 ${END_PATCH} 结束`);
    if (endIndex !== lines.length - 1) fail('INVALID_PATCH', `${END_PATCH} 后不能包含其他内容`);

    const operations = [];
    let index = 1;
    while (index < endIndex) {
        const header = lines[index];
        const match = header.match(FILE_HEADER);
        if (!match) fail('INVALID_PATCH', `补丁第 ${index + 1} 行不是有效的文件操作头`);
        const action = match[1].toLowerCase();
        const filePath = parsePath(match[2], index + 1);
        index += 1;

        const body = [];
        while (index < endIndex && !FILE_HEADER.test(lines[index])) {
            body.push(lines[index]);
            index += 1;
        }

        if (action === 'add') {
            operations.push({ action, path: filePath, content: parseAddBody(body, filePath) });
        } else if (action === 'update') {
            operations.push({ action, path: filePath, hunks: parseUpdateBody(body, filePath) });
        } else {
            if (body.length > 0) fail('INVALID_PATCH', `删除文件 ${filePath} 的操作头后不能包含内容`);
            operations.push({ action, path: filePath });
        }
    }

    if (operations.length === 0) fail('INVALID_PATCH', 'patch 至少需要一个文件操作');
    return operations;
}

module.exports = {
    BEGIN_PATCH,
    END_PATCH,
    NO_NEWLINE,
    PatchError,
    parsePatch,
};
