'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const providers = require('../model-providers');
const { createModelCapability } = require('../runtime/model-runtime');
const {
    buildLiveTrajectoryEvidence,
    refineFromLiveTrajectories,
} = require('../skill-refinement/live-trajectory-refiner');

async function main() {
    const projectRoot = path.resolve(__dirname, '..');
    const skillPath = path.join(
        projectRoot, '.agents', 'skills', 'pywright-headless-player', 'SKILL.md'
    );
    const trajectoryRoot = path.join(projectRoot, '.code', 'pywright-agent');
    const trajectoryFiles = fs.readdirSync(trajectoryRoot)
        .filter(name => /^trajectory-.*\.jsonl$/i.test(name))
        .map(name => path.join(trajectoryRoot, name))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
        .slice(0, 8)
        .reverse();
    if (trajectoryFiles.length === 0) throw new Error('No timestamped real gameplay trajectories found');

    const prepareOnly = process.argv.includes('--prepare-only');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputRoot = path.join(
        projectRoot, '.code', 'pywright-agent', 'refinement', timestamp
    );
    fs.mkdirSync(outputRoot, { recursive: true });
    const evidencePath = path.join(outputRoot, 'live-evidence.json');
    const evidence = buildLiveTrajectoryEvidence(trajectoryFiles);
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    if (prepareOnly) {
        process.stdout.write(`${JSON.stringify({
            modelInvoked: false,
            trajectoryCount: trajectoryFiles.length,
            evidencePath: path.relative(projectRoot, evidencePath),
        }, null, 2)}\n`);
        return;
    }

    const client = providers.resolveDefault();
    const model = createModelCapability(client, providers.config.default);
    try {
        const result = await refineFromLiveTrajectories({
            model,
            skill: fs.readFileSync(skillPath, 'utf8'),
            task: '在本地 Docker 沙箱中由 Qwen 实际操作 Turnabout Scapegoat，避免菜单误判和循环，并推进到可验证的案件检查点。',
            trajectoryFiles,
        });
        const reflectionPath = path.join(outputRoot, 'reflection.json');
        const candidatePath = path.join(outputRoot, 'candidate-skill.md');
        fs.writeFileSync(reflectionPath, `${JSON.stringify({
            diagnosis: result.reflection.diagnosis,
            successfulPatterns: result.reflection.successfulPatterns,
            changes: result.reflection.changes,
        }, null, 2)}\n`, 'utf8');
        fs.writeFileSync(candidatePath, `${result.reflection.candidateSkillMarkdown}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify({
            model: model.info(),
            trajectoryCount: trajectoryFiles.length,
            evidencePath: path.relative(projectRoot, evidencePath),
            reflectionPath: path.relative(projectRoot, reflectionPath),
            candidatePath: path.relative(projectRoot, candidatePath),
        }, null, 2)}\n`);
    } finally {
        if (typeof client.dispose === 'function') await client.dispose();
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
