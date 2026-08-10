const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function decode(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(document, pointer) {
    if (pointer === '') return { exists: true, value: document };
    let value = document;
    for (const raw of pointer.slice(1).split('/')) {
        const key = decode(raw);
        if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
            return { exists: false, value: undefined };
        }
        value = value[key];
    }
    return { exists: true, value };
}

module.exports = {
    type: 'json',
    verify(check, runtime = {}) {
        const fileSystem = runtime.fileSystem;
        if (!fileSystem || typeof fileSystem.resolveExisting !== 'function') {
            return { status: 'INCONCLUSIVE', summary: 'File capability is unavailable', evidence: {} };
        }
        let document;
        try {
            const resolved = fileSystem.resolveExisting(check.path, { type: 'file' });
            document = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        } catch (error) {
            if (error.code === 'WORKSPACE_APPROVAL_REQUIRED') {
                return { status: 'INCONCLUSIVE', summary: error.message, evidence: { code: error.code } };
            }
            return { status: 'FAIL', summary: `JSON could not be read: ${error.message}`, evidence: { path: check.path } };
        }
        const evidence = [];
        for (const assertion of check.assertions) {
            const actual = resolvePointer(document, assertion.pointer);
            let passed = actual.exists === assertion.exists;
            if (passed && assertion.exists) {
                if (assertion.valueType !== undefined) passed = valueType(actual.value) === assertion.valueType;
                if (passed && Object.prototype.hasOwnProperty.call(assertion, 'equals')) {
                    passed = isDeepStrictEqual(actual.value, assertion.equals);
                }
            }
            evidence.push({
                pointer: assertion.pointer,
                passed,
                exists: actual.exists,
                actualType: actual.exists ? valueType(actual.value) : null,
            });
            if (!passed) {
                return { status: 'FAIL', summary: `JSON assertion failed at ${assertion.pointer || '/'}`, evidence: { assertions: evidence } };
            }
        }
        return { status: 'PASS', summary: 'JSON assertions passed', evidence: { path: check.path, assertions: evidence } };
    },
};

module.exports.resolvePointer = resolvePointer;
