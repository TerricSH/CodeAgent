const fs = require('node:fs');
const path = require('node:path');
const { requireCapability } = require('../../runtime/capabilities');
const { formatCapabilityError } = require('../capability-error');
const { PatchError, parsePatch } = require('./parser');
const { applyFileTransaction, prepareChanges } = require('./engine');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const definition = {
    type: 'function',
    function: {
        name: 'apply_patch',
        description: '事务式应用可新增、更新或删除多个 UTF-8 文本文件的 patch；整批成功或失败回滚',
        parameters: {
            type: 'object',
            properties: {
                patch: {
                    type: 'string',
                    description: '以 *** Begin Patch 开头、以 *** End Patch 结束的多文件 patch',
                    minLength: 1,
                },
            },
            required: ['patch'],
            additionalProperties: false,
        },
    },
};

const capabilities = { required: ['fileSystem'] };

function summarize(changes) {
    const summary = { total: changes.length, added: 0, updated: 0, deleted: 0 };
    const counters = { add: 'added', update: 'updated', delete: 'deleted' };
    const files = changes.map((change) => {
        const action = change.operation.action;
        summary[counters[action]] += 1;
        return {
            path: change.operation.path,
            resolvedPath: change.displayPath,
            action,
        };
    });
    return { summary, files };
}

function parseCapabilityDetail(fileSystem, error) {
    const formatted = formatCapabilityError(fileSystem, error, '应用补丁失败');
    try {
        const parsed = JSON.parse(formatted);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function errorResult(fileSystem, error) {
    const capabilityDetail = parseCapabilityDetail(fileSystem, error) || {};
    const transaction = error?.transaction || {
        committed: false,
        rolledBack: false,
        unchanged: true,
        phase: 'preflight',
        cleanupWarnings: [],
    };
    const result = {
        ...capabilityDetail,
        ok: false,
        code: capabilityDetail.code
            || (error instanceof PatchError ? error.code : 'APPLY_PATCH_FAILED'),
        error: error instanceof Error ? error.message : String(error),
        transaction,
    };
    if (error instanceof PatchError && Object.keys(error.details || {}).length > 0) {
        result.details = error.details;
    }
    return JSON.stringify(result, null, 2);
}

function createHandler(options = {}) {
    return function handler(args = {}, context, injectedCapabilities) {
        let fileSystem = null;
        try {
            fileSystem = requireCapability(injectedCapabilities, 'fileSystem');
            const operations = parsePatch(args && args.patch);
            const changes = prepareChanges(operations, fileSystem, { fileOps: options.fileOps });
            const transaction = applyFileTransaction(changes, {
                fileOps: options.fileOps,
                transactionId: options.transactionId,
            });
            const { summary, files } = summarize(changes);
            return JSON.stringify({
                ok: true,
                summary,
                files,
                transaction,
            }, null, 2);
        } catch (error) {
            return errorResult(fileSystem, error);
        }
    };
}

const handler = createHandler();

module.exports = {
    definition,
    handler,
    prompt,
    capabilities,
    effects: 'write',
    createHandler,
};
