const EDIT_OPS = new Set(['append', 'insert_after', 'replace', 'delete']);
const PROTECTED_REGIONS = Object.freeze([
    ['<!-- SLOW_UPDATE_START -->', '<!-- SLOW_UPDATE_END -->'],
    ['<!-- APPENDIX_START -->', '<!-- APPENDIX_END -->'],
]);
const SLOW_UPDATE_REGION = PROTECTED_REGIONS[0];

function stripFence(value) {
    const text = String(value || '').trim();
    const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return (match ? match[1] : text).trim();
}

function parsePatch(value) {
    let raw = value;
    if (typeof value === 'string') {
        try {
            raw = JSON.parse(stripFence(value));
        } catch (error) {
            throw new Error(`Skill Patch is not valid JSON: ${error.message}`);
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Skill Patch must be an object');
    }
    if (!Array.isArray(raw.edits)) throw new Error('Skill Patch edits must be an array');
    const edits = raw.edits.map((edit, index) => {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
            throw new Error(`Skill Patch edit ${index + 1} must be an object`);
        }
        if (!EDIT_OPS.has(edit.op)) {
            throw new Error(`Skill Patch edit ${index + 1} has unsupported op: ${edit.op}`);
        }
        if (edit.content !== undefined && typeof edit.content !== 'string') {
            throw new Error(`Skill Patch edit ${index + 1} content must be a string`);
        }
        if (edit.target !== undefined && typeof edit.target !== 'string') {
            throw new Error(`Skill Patch edit ${index + 1} target must be a string`);
        }
        if (edit.op !== 'append' && !String(edit.target || '')) {
            throw new Error(`Skill Patch edit ${index + 1} requires target`);
        }
        if (edit.op !== 'delete' && !String(edit.content || '').trim()) {
            throw new Error(`Skill Patch edit ${index + 1} requires non-empty content`);
        }
        return Object.freeze({
            op: edit.op,
            content: String(edit.content || ''),
            target: String(edit.target || ''),
            supportCount: Number.isInteger(edit.support_count)
                ? edit.support_count
                : (Number.isInteger(edit.supportCount) ? edit.supportCount : null),
            sourceType: ['failure', 'success'].includes(edit.source_type)
                ? edit.source_type
                : (['failure', 'success'].includes(edit.sourceType) ? edit.sourceType : null),
            mergeLevel: Number.isInteger(edit.merge_level)
                ? edit.merge_level
                : (Number.isInteger(edit.mergeLevel) ? edit.mergeLevel : null),
            updateOrigin: String(edit.update_origin || edit.updateOrigin || ''),
            updateTarget: String(edit.update_target || edit.updateTarget || ''),
        });
    });
    return Object.freeze({
        reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
        rankingDetails: raw.ranking_details && typeof raw.ranking_details === 'object'
            ? raw.ranking_details
            : (raw.rankingDetails || null),
        failureSummary: Array.isArray(raw.failure_summary)
            ? Object.freeze(raw.failure_summary)
            : (Array.isArray(raw.failureSummary) ? Object.freeze(raw.failureSummary) : Object.freeze([])),
        successPatterns: Array.isArray(raw.success_patterns)
            ? Object.freeze(raw.success_patterns.map(String))
            : (Array.isArray(raw.successPatterns)
                ? Object.freeze(raw.successPatterns.map(String))
                : Object.freeze([])),
        edits: Object.freeze(edits),
    });
}

function editPriority(edit, index) {
    return {
        edit,
        index,
        support: Number.isInteger(edit.supportCount) ? edit.supportCount : 1,
        failure: edit.sourceType === 'failure' ? 1 : 0,
        merge: Number.isInteger(edit.mergeLevel) ? edit.mergeLevel : 0,
    };
}

function selectPatchEdits(value, budget) {
    const patch = parsePatch(value);
    const limit = Math.max(0, Number.isInteger(Number(budget)) ? Number(budget) : patch.edits.length);
    if (limit === 0) return parsePatch({ reasoning: patch.reasoning, edits: [] });
    const ranked = patch.edits.map(editPriority).sort((left, right) => (
        right.support - left.support
        || right.failure - left.failure
        || right.merge - left.merge
        || left.index - right.index
    ));
    const seen = new Set();
    const selected = [];
    for (const item of ranked) {
        const edit = item.edit;
        const key = edit.op === 'append'
            ? `append:${edit.content.trim()}`
            : `target:${edit.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(edit);
        if (selected.length >= limit) break;
    }
    return parsePatch({
        reasoning: patch.reasoning,
        ranking_details: {
            ...(patch.rankingDetails || {}),
            proposed: patch.edits.length,
            selected: selected.length,
            budget: limit,
        },
        failure_summary: patch.failureSummary,
        success_patterns: patch.successPatterns,
        edits: selected,
    });
}

function replaceSlowUpdate(skill, content) {
    const [start, end] = SLOW_UPDATE_REGION;
    const source = String(skill || '');
    const guidance = sanitizeContent(content).trim();
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end);
    if ((startIndex === -1) !== (endIndex === -1) || (startIndex !== -1 && endIndex < startIndex)) {
        throw new Error('Skill contains a malformed SLOW_UPDATE protected region');
    }
    const block = `${start}\n${guidance}\n${end}`;
    if (startIndex !== -1) {
        return source.slice(0, startIndex) + block + source.slice(endIndex + end.length);
    }
    const appendixStart = source.indexOf(PROTECTED_REGIONS[1][0]);
    if (appendixStart === -1) return `${source.trimEnd()}\n\n${block}\n`;
    return `${source.slice(0, appendixStart).trimEnd()}\n\n${block}\n\n${source.slice(appendixStart)}`;
}

function earliestProtectedStart(skill) {
    const positions = PROTECTED_REGIONS
        .map(([start]) => skill.indexOf(start))
        .filter(index => index !== -1);
    return positions.length > 0 ? Math.min(...positions) : -1;
}

function targetInProtectedRegion(skill, target) {
    if (!target) return false;
    const targetIndex = skill.indexOf(target);
    if (targetIndex === -1) return false;
    const targetEnd = targetIndex + target.length;
    return PROTECTED_REGIONS.some(([start, end]) => {
        const startIndex = skill.indexOf(start);
        const endIndex = skill.indexOf(end);
        if (startIndex === -1) return false;
        const protectedEnd = endIndex === -1 ? skill.length : endIndex + end.length;
        return targetIndex < protectedEnd && targetEnd > startIndex;
    });
}

function sanitizeContent(content) {
    return PROTECTED_REGIONS.reduce(
        (text, [start, end]) => text.replaceAll(start, '').replaceAll(end, ''),
        String(content || '')
    );
}

function appendBeforeProtected(skill, content, status) {
    const protectedStart = earliestProtectedStart(skill);
    if (protectedStart === -1) {
        return [skill.trimEnd() + `\n\n${content}\n`, status];
    }
    const before = skill.slice(0, protectedStart).trimEnd();
    const after = skill.slice(protectedStart);
    return [before + `\n\n${content}\n\n` + after, `${status}_before_protected_region`];
}

function applyEdit(skill, edit) {
    const content = sanitizeContent(edit.content);
    const target = edit.target;
    if (edit.op !== 'delete' && !content.trim()) return [skill, 'skipped_empty_content'];
    if (target && targetInProtectedRegion(skill, target)) {
        return [skill, 'skipped_protected_region'];
    }
    if (edit.op === 'append') return appendBeforeProtected(skill, content, 'applied_append');
    if (edit.op === 'insert_after') {
        if (!target || !skill.includes(target)) {
            return [skill, 'skipped_insert_after_target_not_found'];
        }
        const targetEnd = skill.indexOf(target) + target.length;
        const newline = skill.indexOf('\n', targetEnd);
        const insertion = newline === -1 ? skill.length : newline + 1;
        return [skill.slice(0, insertion) + `\n${content}\n` + skill.slice(insertion), 'applied_insert_after'];
    }
    if (!skill.includes(target)) return [skill, `skipped_${edit.op}_target_not_found`];
    if (edit.op === 'replace') return [skill.replace(target, content), 'applied_replace'];
    if (edit.op === 'delete') return [skill.replace(target, ''), 'applied_delete'];
    return [skill, 'skipped_unknown_op'];
}

function applyPatchWithReport(skill, value) {
    const patch = parsePatch(value);
    let candidate = String(skill || '');
    const reports = [];
    for (const [index, edit] of patch.edits.entries()) {
        try {
            const [updated, status] = applyEdit(candidate, edit);
            candidate = updated;
            reports.push({
                index: index + 1,
                op: edit.op,
                target: edit.target.slice(0, 200),
                contentPreview: edit.content.slice(0, 200),
                status,
            });
        } catch (error) {
            reports.push({
                index: index + 1,
                op: edit.op,
                target: edit.target.slice(0, 200),
                contentPreview: edit.content.slice(0, 200),
                status: 'error',
                error: error.message,
            });
        }
    }
    return {
        patch,
        skill: candidate,
        changed: candidate !== String(skill || ''),
        reports,
    };
}

module.exports = {
    stripFence,
    parsePatch,
    selectPatchEdits,
    replaceSlowUpdate,
    applyPatchWithReport,
};
