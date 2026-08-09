'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadPrompt, loadPromptTemplate } = require('../prompts/loader');

const systemPrompt = loadPrompt(path.join(__dirname, 'prompts', 'live-refiner-system.md'));
const renderUserPrompt = loadPromptTemplate(path.join(__dirname, 'prompts', 'live-refiner-user.md'));

function actionKey(decision = {}) {
    if (decision.action === 'key') return `key:${decision.key || ''}`;
    if (decision.action === 'click') return `click:${decision.x},${decision.y}`;
    return String(decision.action || 'unknown');
}

function ocrSignature(value) {
    return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function lastCheckpointScene(observation = {}) {
    const scripts = observation.save?.scripts || [];
    const script = scripts.at(-1);
    return script ? `${script.scene || 'unknown'}:${script.si ?? '?'}` : null;
}

function parseTrajectory(file) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const records = lines.map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`${file}:${index + 1}: invalid JSONL: ${error.message}`);
        }
    });
    const actions = records.filter(record => Number.isInteger(record.step) && record.observation);
    const repetition = new Map();
    for (const record of actions) {
        const key = `${ocrSignature(record.observation.ocrText)}|${actionKey(record.decision)}`;
        repetition.set(key, [...(repetition.get(key) || []), record.step]);
    }
    const repeatedPatterns = [...repetition.entries()]
        .filter(([, steps]) => steps.length >= 2)
        .map(([key, steps]) => ({ key, steps }))
        .sort((left, right) => right.steps.length - left.steps.length)
        .slice(0, 12);
    return {
        file: path.basename(file),
        recordCount: actions.length,
        fatal: records.find(record => record.fatal)?.error || null,
        changedFrameCount: actions.reduce((count, record, index) => {
            if (index === 0) return count;
            return count + (record.observation.sha256 !== actions[index - 1].observation.sha256 ? 1 : 0);
        }, 0),
        repeatedPatterns,
        steps: actions.map(record => ({
            step: record.step,
            screenshotHash: record.observation.sha256,
            ocr: record.observation.ocrText,
            hints: record.observation.hints || [],
            checkpoint: lastCheckpointScene(record.observation),
            routeFlags: record.observation.save?.flags || {},
            inventory: (record.observation.save?.items || []).map(item => item.id),
            decision: record.decision,
            rejectedAttempts: (record.attempts || [])
                .filter(attempt => attempt.violation)
                .map(attempt => ({ decision: attempt.decision, violation: attempt.violation })),
        })),
    };
}

function parseReflectionJson(text) {
    const raw = String(text || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
    try {
        return JSON.parse(raw);
    } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('Reflection model did not return JSON');
        return JSON.parse(raw.slice(start, end + 1));
    }
}

function validateReflection(value) {
    if (!value || typeof value !== 'object') throw new Error('Live reflection result is empty');
    for (const field of ['diagnosis', 'successfulPatterns', 'changes']) {
        if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string')) {
            throw new Error(`Live reflection field ${field} must be a string array`);
        }
    }
    const candidate = String(value.candidateSkillMarkdown || '').trim();
    if (!candidate.startsWith('---') || !candidate.includes('name: pywright-headless-player')) {
        throw new Error('Live reflection candidate is not the pywright-headless-player Skill');
    }
    if (candidate.length > 64000) throw new Error('Live reflection candidate exceeds 64000 characters');
    return { ...value, candidateSkillMarkdown: candidate };
}

async function refineFromLiveTrajectories({ model, skill, task, trajectoryFiles }) {
    if (!model || typeof model.complete !== 'function') {
        throw new Error('Live trajectory refinement requires a model capability with complete()');
    }
    const evidence = buildLiveTrajectoryEvidence(trajectoryFiles);
    const result = await model.complete([
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: renderUserPrompt({
                skill,
                task,
                evidence: JSON.stringify(evidence, null, 2),
            }),
        },
    ], { temperature: 0.1 });
    return { evidence, reflection: validateReflection(parseReflectionJson(result)) };
}

function buildLiveTrajectoryEvidence(trajectoryFiles) {
    if (!Array.isArray(trajectoryFiles) || trajectoryFiles.length === 0) {
        throw new Error('At least one real trajectory file is required');
    }
    return trajectoryFiles.map(parseTrajectory);
}

module.exports = {
    refineFromLiveTrajectories,
    buildLiveTrajectoryEvidence,
    parseTrajectory,
    parseReflectionJson,
    validateReflection,
};
