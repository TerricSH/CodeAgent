const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadPrompt, loadPromptTemplate } = require('../prompts/loader');
const { parsePatch } = require('./skill-patch');

const REFINER_SYSTEM_PROMPT = loadPrompt(path.join(__dirname, 'prompts', 'refiner-system.md'));
const renderRefinerUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'refiner-user.md'));
const renderAggregateUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'aggregate-user.md'));

function materializeTrajectory(trajectory) {
    if (!trajectory || !Array.isArray(trajectory.spans)) return [];
    return trajectory.spans.map(span => {
        if (span.content !== null && span.content !== undefined) return { ...span };
        if (!span.blobRef?.path) return { ...span, content: null };
        const content = fs.readFileSync(span.blobRef.path, 'utf8');
        const digest = crypto.createHash('sha256').update(content).digest('hex');
        if (span.blobRef.sha256 && digest !== span.blobRef.sha256) {
            throw new Error(`Trajectory blob integrity check failed: ${span.blobRef.path}`);
        }
        if (Number.isInteger(span.blobRef.chars) && content.length !== span.blobRef.chars) {
            throw new Error(`Trajectory blob length check failed: ${span.blobRef.path}`);
        }
        return { ...span, content };
    });
}

function splitOversizedSpan(span, maxChars) {
    const serialized = JSON.stringify(span);
    if (serialized.length <= maxChars) return [span];
    const parts = [];
    const payloadChars = Math.max(1, maxChars - 1000);
    const total = Math.ceil(serialized.length / payloadChars);
    for (let index = 0; index < total; index += 1) {
        parts.push({
            spanId: `${span.spanId}:part-${index + 1}`,
            kind: 'serialized_span_fragment',
            parentSpanId: span.spanId,
            part: index + 1,
            totalParts: total,
            encoding: 'json',
            content: serialized.slice(
                index * payloadChars,
                (index + 1) * payloadChars
            ),
        });
    }
    return parts;
}

function reflectionCharacterBudget(modelInfo, fixedCharacters = 0) {
    const configuredContextTokens = Number(modelInfo?.maxContextTokens);
    const maxContextTokens = Number.isFinite(configuredContextTokens)
        && configuredContextTokens > 0
        ? configuredContextTokens
        : 32768;
    const maxOutputTokens = Number(modelInfo?.maxOutputTokens) || 4096;
    if (maxContextTokens <= maxOutputTokens) {
        throw new Error('Reflection model context window must exceed its output reserve');
    }
    const availableCharacters = Math.floor(maxContextTokens - maxOutputTokens) - fixedCharacters;
    if (availableCharacters < 1024) {
        throw new Error(
            'Reflection model context window is too small for the current Skill and prompt'
        );
    }
    return availableCharacters;
}

function partitionTrajectory(spans, modelInfo, fixedCharacters = 0) {
    if (spans.length === 0) return [[]];
    const availableCharacters = reflectionCharacterBudget(modelInfo, fixedCharacters);
    const expanded = spans.flatMap(span => splitOversizedSpan(span, availableCharacters));
    const chunks = [];
    let current = [];
    let characters = 0;
    for (const span of expanded) {
        const size = JSON.stringify(span).length;
        if (current.length > 0 && characters + size > availableCharacters) {
            chunks.push(current);
            current = [];
            characters = 0;
        }
        current.push(span);
        characters += size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function partitionPatches(patches, maxCharacters) {
    const groups = [];
    let current = [];
    for (const patch of patches) {
        if (JSON.stringify([patch], null, 2).length > maxCharacters) {
            throw new Error('One reflected Skill Patch exceeds the aggregation context budget');
        }
        const candidate = [...current, patch];
        if (JSON.stringify(candidate, null, 2).length > maxCharacters) {
            groups.push(current);
            current = [patch];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

async function generatePatch(model, messages, purpose, trajectoryContext) {
    const response = typeof model.completeDetailed === 'function'
        ? await model.completeDetailed(messages, { purpose, trajectoryContext })
        : { content: await model.complete(messages, { purpose, trajectoryContext }), reasoning: '' };
    return {
        patch: parsePatch(response.content),
        modelReasoning: response.reasoning || '',
    };
}

async function reflectSkillPatch({ model, suite, trajectory, currentSkill, epoch, step }) {
    if (!model || typeof model.complete !== 'function') {
        throw new Error('Skill Refinement reflection requires a reliable model capability');
    }
    const spans = materializeTrajectory(trajectory);
    const modelInfo = typeof model.info === 'function' ? model.info() || {} : {};
    const fixedCharacters = String(currentSkill || '').length + String(suite.task || '').length + 8000;
    const chunks = partitionTrajectory(spans, modelInfo, fixedCharacters);
    const rawPatches = [];
    for (const [index, chunk] of chunks.entries()) {
        const messages = [
            { role: 'system', content: REFINER_SYSTEM_PROMPT },
            {
                role: 'user',
                content: renderRefinerUser({
                    skill: currentSkill,
                    task: suite.task,
                    epoch,
                    step,
                    chunk: `${index + 1}/${chunks.length}`,
                    evidence: JSON.stringify(chunk, null, 2),
                }),
            },
        ];
        rawPatches.push(await generatePatch(model, messages, 'reflection', {
            suiteId: suite.id,
            epoch,
            step,
            chunk: index + 1,
            chunks: chunks.length,
        }));
    }
    if (rawPatches.length === 1) return rawPatches[0];

    const aggregationBudget = reflectionCharacterBudget(modelInfo, fixedCharacters);
    let layer = rawPatches.map(item => item.patch);
    let round = 0;
    let lastResponses = [];
    while (layer.length > 1) {
        round += 1;
        const groups = partitionPatches(layer, aggregationBudget);
        if (groups.length === layer.length) {
            throw new Error('Reflection patches cannot be aggregated within the model context window');
        }
        lastResponses = [];
        for (const [groupIndex, patches] of groups.entries()) {
            lastResponses.push(await generatePatch(model, [
                { role: 'system', content: REFINER_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: renderAggregateUser({
                        skill: currentSkill,
                        task: suite.task,
                        epoch,
                        step,
                        patches: JSON.stringify(patches, null, 2),
                    }),
                },
            ], 'reflection-aggregate', {
                suiteId: suite.id,
                epoch,
                step,
                round,
                group: groupIndex + 1,
                groups: groups.length,
            }));
        }
        layer = lastResponses.map(item => item.patch);
    }
    return lastResponses[0];
}

module.exports = {
    reflectSkillPatch,
    materializeTrajectory,
    splitOversizedSpan,
    reflectionCharacterBudget,
    partitionTrajectory,
    partitionPatches,
};
