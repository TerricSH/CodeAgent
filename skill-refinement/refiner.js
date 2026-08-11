const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadPrompt, loadPromptTemplate } = require('../prompts/loader');
const { parsePatch, selectPatchEdits } = require('./skill-patch');

const REFINER_SYSTEM_PROMPT = loadPrompt(path.join(__dirname, 'prompts', 'refiner-system.md'));
const renderFailureAnalysis = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'failure-analysis-user.md')
);
const renderSuccessAnalysis = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'success-analysis-user.md')
);
const renderReflectionReview = loadPromptTemplate(
    path.join(__dirname, 'prompts', 'reflection-review-user.md')
);
const renderAggregateUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'aggregate-user.md'));
const renderRankUser = loadPromptTemplate(path.join(__dirname, 'prompts', 'rank-user.md'));

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

function reflectionCharacterBudget(modelInfo, fixedCharacters = 0) {
    const configuredContextTokens = Number(modelInfo?.maxContextTokens);
    const maxContextTokens = Number.isFinite(configuredContextTokens) && configuredContextTokens > 0
        ? configuredContextTokens
        : 32768;
    const maxOutputTokens = Number(modelInfo?.maxOutputTokens) || 4096;
    if (maxContextTokens <= maxOutputTokens) {
        throw new Error('Reflection model context window must exceed its output reserve');
    }
    const availableCharacters = Math.floor(maxContextTokens - maxOutputTokens) - fixedCharacters;
    if (availableCharacters < 1024) {
        throw new Error('Reflection model context window is too small for the current Skill and prompt');
    }
    return availableCharacters;
}

function partitionPatches(patches, maxCharacters, maxItems = Number.MAX_SAFE_INTEGER) {
    const groups = [];
    let current = [];
    for (const patch of patches) {
        if (JSON.stringify([patch], null, 2).length > maxCharacters) {
            throw new Error('One reflected Skill Patch exceeds the aggregation context budget');
        }
        const candidate = [...current, patch];
        if (current.length > 0 && (
            candidate.length > maxItems
            || JSON.stringify(candidate, null, 2).length > maxCharacters
        )) {
            groups.push(current);
            current = [patch];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

async function mapWithConcurrency(items, limit, worker) {
    const values = new Array(items.length);
    let cursor = 0;
    const count = Math.min(Math.max(1, Number(limit) || 1), Math.max(1, items.length));
    await Promise.all(Array.from({ length: count }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            values[index] = await worker(items[index], index);
        }
    }));
    return values;
}

function normalizedPatchMetadata(value, sourceType = null, mergeLevel = 0) {
    const patch = parsePatch(value);
    return parsePatch({
        reasoning: patch.reasoning,
        ranking_details: patch.rankingDetails,
        failure_summary: patch.failureSummary,
        success_patterns: patch.successPatterns,
        edits: patch.edits.map(edit => ({
            ...edit,
            supportCount: Number.isInteger(edit.supportCount) ? edit.supportCount : 1,
            sourceType: edit.sourceType || sourceType,
            mergeLevel: Math.max(Number.isInteger(edit.mergeLevel) ? edit.mergeLevel : 0, mergeLevel),
        })),
    });
}

async function generatePatch(model, messages, purpose, trajectoryContext) {
    const response = await model.completeDetailed(messages, { purpose, trajectoryContext });
    return {
        patch: parsePatch(response.content),
        modelReasoning: response.reasoning || '',
    };
}

function spanContext(span) {
    return span?.context || span?.payload?.context || {};
}

function evidenceRecords(batch) {
    const spans = materializeTrajectory(batch.trajectory);
    return (batch.rollouts || []).map(rollout => {
        const taskItem = rollout.taskItem
            || (batch.items || []).find(item => item.id === rollout.taskId)
            || null;
        const trajectory = spans.filter(span => {
            const context = spanContext(span);
            return context.batchId === batch.id && context.rolloutId === rollout.id;
        });
        return {
            batchId: batch.id,
            rolloutId: rollout.id,
            taskId: rollout.taskId || taskItem?.id || null,
            task: taskItem?.task || rollout.task || null,
            taskMetadata: taskItem?.metadata || {},
            reward: rollout.score,
            outcome: rollout.success === true ? 'success' : 'failure',
            finalReply: rollout.reply,
            agentError: rollout.agentError,
            evaluation: {
                ok: rollout.evaluation?.ok ?? false,
                failureType: rollout.evaluation?.failureType || null,
                stdout: rollout.evaluation?.stdout || '',
                stderr: rollout.evaluation?.stderr || '',
                error: rollout.evaluation?.error || null,
                rewardError: rollout.evaluation?.rewardError || null,
            },
            protectedPathViolations: rollout.protectedPathViolations || [],
            diff: rollout.diff,
            trajectory,
        };
    });
}

function splitOversizedEvidence(record, maxCharacters) {
    const serialized = JSON.stringify(record);
    if (serialized.length <= maxCharacters) return [record];
    const payloadCharacters = Math.max(1, maxCharacters - 1200);
    const parts = Math.ceil(serialized.length / payloadCharacters);
    return Array.from({ length: parts }, (_, index) => ({
        kind: 'serialized_trajectory_fragment',
        batchId: record.batchId,
        rolloutId: record.rolloutId,
        taskId: record.taskId,
        outcome: record.outcome,
        reward: record.reward,
        part: index + 1,
        totalParts: parts,
        encoding: 'json',
        content: serialized.slice(index * payloadCharacters, (index + 1) * payloadCharacters),
    }));
}

function partitionEvidence(records, minibatchSize, modelInfo, fixedCharacters) {
    if (records.length === 0) return [];
    const maxCharacters = reflectionCharacterBudget(modelInfo, fixedCharacters);
    const expanded = records.flatMap(record => splitOversizedEvidence(record, maxCharacters));
    const groups = [];
    let current = [];
    let characters = 0;
    for (const record of expanded) {
        const size = JSON.stringify(record).length;
        if (current.length > 0 && (
            current.length >= minibatchSize
            || characters + size > maxCharacters
        )) {
            groups.push(current);
            current = [];
            characters = 0;
        }
        current.push(record);
        characters += size;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

function buildAnalysisJobs(evidenceBatches, options) {
    const jobs = [];
    for (const [batchIndex, batch] of evidenceBatches.entries()) {
        const records = evidenceRecords(batch);
        for (const analysisType of ['failure', 'success']) {
            const matching = records.filter(record => record.outcome === analysisType);
            const minibatches = partitionEvidence(
                matching,
                options.minibatchSize,
                options.modelInfo,
                options.fixedCharacters
            );
            for (const [minibatchIndex, evidence] of minibatches.entries()) {
                jobs.push({
                    analysisType,
                    batch: batchIndex + 1,
                    batchId: batch.id,
                    minibatch: minibatchIndex + 1,
                    minibatches: minibatches.length,
                    evidence,
                });
            }
        }
    }
    return jobs;
}

async function analyzeJob(model, job, options) {
    const render = job.analysisType === 'failure' ? renderFailureAnalysis : renderSuccessAnalysis;
    const evidence = JSON.stringify(job.evidence, null, 2);
    let result = await generatePatch(model, [
        { role: 'system', content: REFINER_SYSTEM_PROMPT },
        {
            role: 'user',
            content: render({
                skill: options.currentSkill,
                epoch: options.epoch,
                step: options.step,
                batch: `${job.batch}/${options.evidenceBatches.length}`,
                minibatch: `${job.minibatch}/${job.minibatches}`,
                editBudget: options.editBudget,
                metaSkill: options.metaSkill || '(none)',
                rejectedBuffer: JSON.stringify(options.rejectedBuffer || [], null, 2),
                evidence,
            }),
        },
    ], `reflection-${job.analysisType}`, {
        suiteId: options.suite.id,
        epoch: options.epoch,
        step: options.step,
        batchId: job.batchId,
        analysisType: job.analysisType,
        minibatch: job.minibatch,
        round: 1,
    });
    const reasoning = [result.modelReasoning].filter(Boolean);
    for (let round = 2; round <= options.reflectionRounds; round += 1) {
        const previous = JSON.stringify(result.patch);
        const reviewed = await generatePatch(model, [
            { role: 'system', content: REFINER_SYSTEM_PROMPT },
            {
                role: 'user',
                content: renderReflectionReview({
                    skill: options.currentSkill,
                    analysisType: job.analysisType,
                    metaSkill: options.metaSkill || '(none)',
                    rejectedBuffer: JSON.stringify(options.rejectedBuffer || [], null, 2),
                    evidence,
                    previousPatch: JSON.stringify(result.patch, null, 2),
                }),
            },
        ], `reflection-${job.analysisType}-review`, {
            suiteId: options.suite.id,
            epoch: options.epoch,
            step: options.step,
            batchId: job.batchId,
            analysisType: job.analysisType,
            minibatch: job.minibatch,
            round,
        });
        result = reviewed;
        if (reviewed.modelReasoning) reasoning.push(reviewed.modelReasoning);
        if (JSON.stringify(reviewed.patch) === previous || reviewed.patch.edits.length === 0) break;
    }
    return {
        ...job,
        patch: normalizedPatchMetadata(result.patch, job.analysisType, 0),
        modelReasoning: reasoning.join('\n'),
    };
}

async function mergePatchGroup(model, patches, options) {
    if (patches.length === 1) {
        return {
            patch: normalizedPatchMetadata(patches[0], options.sourceType, options.mergeLevel),
            modelReasoning: '',
        };
    }
    const result = await generatePatch(model, [
        { role: 'system', content: REFINER_SYSTEM_PROMPT },
        {
            role: 'user',
            content: renderAggregateUser({
                skill: options.currentSkill,
                stage: options.stage,
                metaSkill: options.metaSkill || '(none)',
                rejectedBuffer: JSON.stringify(options.rejectedBuffer || [], null, 2),
                patches: JSON.stringify(patches, null, 2),
            }),
        },
    ], 'reflection-aggregate', {
        suiteId: options.suite.id,
        epoch: options.epoch,
        step: options.step,
        stage: options.stage,
        mergeLevel: options.mergeLevel,
        group: options.group,
    });
    return {
        patch: normalizedPatchMetadata(result.patch, options.sourceType, options.mergeLevel),
        modelReasoning: result.modelReasoning,
    };
}

async function mergePatchLayer(model, patches, options) {
    if (patches.length === 0) return { patch: parsePatch({ edits: [] }), reasoning: [] };
    let layer = patches.map(patch => normalizedPatchMetadata(patch, options.sourceType, 0));
    let mergeLevel = 0;
    const reasoning = [];
    while (layer.length > 1) {
        mergeLevel += 1;
        const groups = partitionPatches(layer, options.maxCharacters, options.mergeBatchSize);
        if (groups.every(group => group.length === 1)) {
            throw new Error('Reflection patches cannot be merged within the model context window');
        }
        const merged = await mapWithConcurrency(groups, options.analystWorkers, async (group, index) => (
            mergePatchGroup(model, group, {
                ...options,
                mergeLevel,
                group: index + 1,
            })
        ));
        for (const item of merged) if (item.modelReasoning) reasoning.push(item.modelReasoning);
        layer = merged.map(item => item.patch);
    }
    return { patch: layer[0], reasoning };
}

function editSignature(edit) {
    return JSON.stringify([edit.op, edit.target || '', edit.content || '']);
}

function constrainRankedPatch(rankedValue, poolValue, editBudget) {
    const ranked = parsePatch(rankedValue);
    const pool = parsePatch(poolValue);
    const available = new Map(pool.edits.map(edit => [editSignature(edit), edit]));
    const selected = [];
    for (const edit of ranked.edits) {
        const original = available.get(editSignature(edit));
        if (original) selected.push(original);
    }
    const edits = ranked.edits.length > 0 && selected.length === 0 ? pool.edits : selected;
    return selectPatchEdits({
        reasoning: ranked.reasoning || pool.reasoning,
        ranking_details: ranked.rankingDetails,
        failure_summary: pool.failureSummary,
        success_patterns: pool.successPatterns,
        edits,
    }, editBudget);
}

async function rankMergedPatch(model, patch, options) {
    if (patch.edits.length === 0) return { patch, modelReasoning: '' };
    const ranked = await generatePatch(model, [
        { role: 'system', content: REFINER_SYSTEM_PROMPT },
        {
            role: 'user',
            content: renderRankUser({
                skill: options.currentSkill,
                editBudget: options.editBudget,
                metaSkill: options.metaSkill || '(none)',
                rejectedBuffer: JSON.stringify(options.rejectedBuffer || [], null, 2),
                patch: JSON.stringify(patch, null, 2),
            }),
        },
    ], 'reflection-rank', {
        suiteId: options.suite.id,
        epoch: options.epoch,
        step: options.step,
        editBudget: options.editBudget,
    });
    return {
        patch: constrainRankedPatch(ranked.patch, patch, options.editBudget),
        modelReasoning: ranked.modelReasoning,
    };
}

async function reflectSkillPatch(options) {
    const {
        model,
        suite,
        currentSkill,
        epoch,
        step,
        rejectedBuffer = [],
        metaSkill = '',
        evidenceBatches,
        editBudget,
    } = options;
    if (!model || typeof model.completeDetailed !== 'function') {
        throw new Error('Skill Refinement reflection requires completeDetailed()');
    }
    if (!suite?.optimizer) throw new Error('Skill Refinement reflection requires suite.optimizer');
    if (!Array.isArray(evidenceBatches) || evidenceBatches.length === 0) {
        throw new Error('Skill Refinement reflection requires non-empty evidenceBatches');
    }
    if (!Number.isInteger(editBudget) || editBudget < 1) {
        throw new Error('Skill Refinement reflection requires a positive integer editBudget');
    }
    const modelInfo = typeof model.info === 'function' ? model.info() || {} : {};
    const fixedCharacters = String(currentSkill || '').length
        + String(metaSkill || '').length
        + JSON.stringify(rejectedBuffer || []).length
        + 8000;
    const analysisOptions = {
        suite,
        currentSkill,
        epoch,
        step,
        evidenceBatches,
        rejectedBuffer,
        metaSkill,
        modelInfo,
        fixedCharacters,
        minibatchSize: suite.optimizer.reflectionMinibatchSize,
        mergeBatchSize: suite.optimizer.mergeBatchSize,
        analystWorkers: suite.optimizer.analystWorkers,
        reflectionRounds: suite.optimizer.reflectionRounds,
        editBudget,
    };
    const jobs = buildAnalysisJobs(evidenceBatches, analysisOptions);
    const analyses = await mapWithConcurrency(
        jobs,
        analysisOptions.analystWorkers,
        job => analyzeJob(model, job, analysisOptions)
    );
    const maxCharacters = reflectionCharacterBudget(modelInfo, fixedCharacters);
    const commonMerge = {
        ...analysisOptions,
        maxCharacters,
    };
    const failureAnalyses = analyses.filter(item => item.analysisType === 'failure');
    const successAnalyses = analyses.filter(item => item.analysisType === 'success');
    const failureMerge = await mergePatchLayer(
        model,
        failureAnalyses.map(item => item.patch),
        { ...commonMerge, stage: 'failure consolidation', sourceType: 'failure' }
    );
    const successMerge = await mergePatchLayer(
        model,
        successAnalyses.map(item => item.patch),
        { ...commonMerge, stage: 'success consolidation', sourceType: 'success' }
    );
    let mergedPatch;
    const mergeReasoning = [...failureMerge.reasoning, ...successMerge.reasoning];
    if (failureMerge.patch.edits.length > 0 && successMerge.patch.edits.length > 0) {
        const finalMerge = await mergePatchGroup(model, [failureMerge.patch, successMerge.patch], {
            ...commonMerge,
            stage: 'final failure-prioritized merge',
            sourceType: null,
            mergeLevel: 1,
            group: 1,
        });
        mergedPatch = finalMerge.patch;
        if (finalMerge.modelReasoning) mergeReasoning.push(finalMerge.modelReasoning);
    } else {
        mergedPatch = failureMerge.patch.edits.length > 0 ? failureMerge.patch : successMerge.patch;
    }
    const ranked = await rankMergedPatch(model, mergedPatch, {
        ...analysisOptions,
        editBudget,
    });
    const failurePatterns = failureAnalyses.flatMap(item => item.patch.failureSummary);
    const successPatterns = successAnalyses.flatMap(item => item.patch.successPatterns);
    return {
        patch: ranked.patch,
        modelReasoning: [
            ...analyses.map(item => item.modelReasoning),
            ...mergeReasoning,
            ranked.modelReasoning,
        ].filter(Boolean).join('\n'),
        failurePatterns,
        successPatterns,
        analysis: {
            failureMinibatches: failureAnalyses.length,
            successMinibatches: successAnalyses.length,
            editBudget,
            proposedEdits: mergedPatch.edits.length,
            selectedEdits: ranked.patch.edits.length,
        },
    };
}

module.exports = {
    reflectSkillPatch,
};
