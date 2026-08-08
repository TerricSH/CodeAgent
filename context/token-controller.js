const {
    estimateTokens,
    estimateToolsTokens,
    estimateRequestTokens,
} = require('./tokens');
const { defaultOutputReserve } = require('../model-providers/interfaces/base-interface');

function sortByRetention(left, right, turn) {
    const leftCurrent = left.lastUsedTurn === turn ? 1 : 0;
    const rightCurrent = right.lastUsedTurn === turn ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    if (left.useCount !== right.useCount) return right.useCount - left.useCount;
    if (left.lastUsedTurn !== right.lastUsedTurn) return right.lastUsedTurn - left.lastUsedTurn;
    if (left.tokenCount !== right.tokenCount) return left.tokenCount - right.tokenCount;
    return right.sequence - left.sequence;
}

function tokenCounter(profile) {
    return profile && typeof profile.countTokens === 'function'
        ? profile.countTokens
        : estimateRequestTokens;
}

function atomicGroups(entries = []) {
    const groups = new Map();
    for (const entry of entries) {
        const id = entry.atomicGroupId || entry.id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(entry);
    }
    return [...groups.values()];
}

function groupRetention(group, turn) {
    return {
        lastUsedTurn: Math.max(...group.map(entry => entry.lastUsedTurn)),
        useCount: Math.max(...group.map(entry => entry.useCount)),
        tokenCount: group.reduce((sum, entry) => sum + entry.tokenCount, 0),
        sequence: Math.min(...group.map(entry => entry.sequence)),
        turn,
    };
}

function prepare(cache, systemMessage, options = {}) {
    const profile = options.modelProfile || {};
    const tools = Array.isArray(options.tools) ? options.tools : [];
    const window = Number.isInteger(profile.maxContextTokens) && profile.maxContextTokens > 0
        ? profile.maxContextTokens
        : (Number.isInteger(options.maxContextTokens) ? options.maxContextTokens : 32768);
    const outputReserve = Number.isInteger(profile.maxOutputTokens) && profile.maxOutputTokens > 0
        ? profile.maxOutputTokens
        : defaultOutputReserve(window);
    const safetyMargin = Number.isInteger(options.safetyMargin) && options.safetyMargin >= 0
        ? options.safetyMargin
        : Math.max(1024, Math.ceil(window * 0.01));
    const systemTokens = systemMessage ? estimateTokens(systemMessage) : 0;
    const toolTokens = estimateToolsTokens(tools);
    const resident = cache.entries.filter(entry => entry.resident && entry.messages.length > 0);
    const latestUser = [...resident].reverse().find(entry => entry.messages.some(message => message.role === 'user'));
    const groups = atomicGroups(resident);
    const requiredGroupIds = new Set(groups
        .filter(group => group.some(entry => entry.required || entry === latestUser))
        .map(group => group[0].atomicGroupId || group[0].id));
    let required = groups
        .filter(group => requiredGroupIds.has(group[0].atomicGroupId || group[0].id))
        .flat();
    let requiredTokens = required.reduce((sum, entry) => sum + entry.tokenCount, 0);
    let mandatoryTokens = systemTokens + toolTokens + requiredTokens;
    const reasons = [];

    // Closed Tool/Subagent spans must be delivered once, but their full payload can
    // exceed a smaller child/model window. Preserve the full snapshot in Audit and
    // replace only the model-side representation with a source reference.
    if (mandatoryTokens + outputReserve + safetyMargin > window) {
        const compressible = required
            .filter(entry => entry !== latestUser && entry.metadata?.closed === true)
            .sort((left, right) => right.tokenCount - left.tokenCount);
        for (const entry of compressible) {
            cache.compactToSource(entry.id, 'required-content-too-large');
            reasons.push({
                id: entry.id,
                kind: entry.kind,
                reason: 'required-content-too-large',
                representation: 'source-only',
            });
            requiredTokens = required.reduce((sum, item) => sum + item.tokenCount, 0);
            mandatoryTokens = systemTokens + toolTokens + requiredTokens;
            if (mandatoryTokens + outputReserve + safetyMargin <= window) break;
        }
    }

    const requiredIds = new Set(required.map(entry => entry.id));
    const dynamicCapacity = Math.max(0, window - outputReserve - safetyMargin - mandatoryTokens);

    if (mandatoryTokens + outputReserve + safetyMargin > window) {
        const error = new Error('Required context exceeds the model window. Split the current input or reduce tool schemas.');
        error.code = 'CONTEXT_REQUIRED_INPUT_TOO_LARGE';
        error.usage = { window, outputReserve, safetyMargin, mandatoryTokens, dynamicCapacity };
        throw error;
    }

    const selected = [...required];
    const selectedGroups = groups.filter(group =>
        requiredGroupIds.has(group[0].atomicGroupId || group[0].id)
    );
    let dynamicUsed = 0;
    const candidates = groups
        .filter(group => !requiredGroupIds.has(group[0].atomicGroupId || group[0].id))
        .sort((left, right) => sortByRetention(
            groupRetention(left, cache.turn),
            groupRetention(right, cache.turn),
            cache.turn
        ));

    for (const group of candidates) {
        const groupTokens = group.reduce((sum, entry) => sum + entry.tokenCount, 0);
        if (dynamicUsed + groupTokens <= dynamicCapacity) {
            selected.push(...group);
            selectedGroups.push(group);
            dynamicUsed += groupTokens;
        } else {
            cache.evict(group[0].id, 'token-pressure');
            reasons.push({
                id: group[0].atomicGroupId || group[0].id,
                nodeIds: group.map(entry => entry.id),
                kind: group.map(entry => entry.kind).join('+'),
                reason: 'token-pressure',
            });
        }
    }

    selected.sort((left, right) => left.sequence - right.sequence);
    let messages = [systemMessage, ...selected.flatMap(entry => entry.messages)].filter(Boolean);
    const count = tokenCounter(profile);
    let actual = count(messages, tools);
    if (!Number.isFinite(actual)) actual = estimateRequestTokens(messages, tools);
    while (actual + outputReserve + safetyMargin > window) {
        const removableGroup = [...selectedGroups]
            .filter(group => !requiredGroupIds.has(group[0].atomicGroupId || group[0].id))
            .sort((left, right) => -sortByRetention(
                groupRetention(left, cache.turn),
                groupRetention(right, cache.turn),
                cache.turn
            ))[0];
        if (!removableGroup) {
            const error = new Error('Provider token count exceeds the model window after all optional context was evicted.');
            error.code = 'CONTEXT_PROVIDER_COUNT_EXCEEDED';
            throw error;
        }
        const removableIds = new Set(removableGroup.map(entry => entry.id));
        for (let index = selected.length - 1; index >= 0; index -= 1) {
            if (removableIds.has(selected[index].id)) selected.splice(index, 1);
        }
        selectedGroups.splice(selectedGroups.indexOf(removableGroup), 1);
        cache.evict(removableGroup[0].id, 'provider-token-recount');
        reasons.push({
            id: removableGroup[0].atomicGroupId || removableGroup[0].id,
            nodeIds: [...removableIds],
            kind: removableGroup.map(entry => entry.kind).join('+'),
            reason: 'provider-token-recount',
        });
        messages = [systemMessage, ...selected.flatMap(entry => entry.messages)].filter(Boolean);
        actual = count(messages, tools);
        if (!Number.isFinite(actual)) actual = estimateRequestTokens(messages, tools);
    }

    for (const entry of selected) {
        cache.touch(entry.id, 'sent-to-model');
        if (entry.metadata?.mustSend) {
            entry.metadata.sentOnce = true;
            entry.metadata.mustSend = false;
            entry.required = false;
        }
    }
    dynamicUsed = selected
        .filter(entry => !requiredIds.has(entry.id))
        .reduce((sum, entry) => sum + entry.tokenCount, 0);
    const byType = {};
    for (const entry of selected) byType[entry.kind] = (byType[entry.kind] || 0) + entry.tokenCount;
    return {
        messages,
        tools,
        selectedNodeIds: selected.map(entry => entry.id),
        usage: {
            window,
            outputReserve,
            safetyMargin,
            mandatoryTokens,
            dynamicCapacity,
            dynamicUsed,
            requestTokens: actual,
            remaining: Math.max(0, window - outputReserve - safetyMargin - actual),
            systemTokens,
            toolSchemaTokens: toolTokens,
            byType,
            residentNodes: cache.entries.filter(entry => entry.resident).length,
            coldNodes: cache.entries.filter(entry => !entry.resident).length,
            maxResidentCount: selected.length,
            reductionReasons: reasons,
        },
    };
}

module.exports = { prepare, sortByRetention, atomicGroups };
