const fs = require('node:fs');
const path = require('node:path');
const { sessionKey } = require('../sandbox/policy');
const { pathIsInside, ensureContainedDirectory } = require('../sandbox/workspace');

class RefinementArtifactRepository {
    constructor(sessionId, config) {
        this.config = config;
        this.runRoot = path.join(
            config.sandboxRoot,
            sessionKey(sessionId),
            'skill-refinement-runs'
        );
    }

    createRun(runId) {
        const artifactRoot = path.join(this.runRoot, runId);
        ensureContainedDirectory(this.config.sandboxRoot, artifactRoot, 'Skill Refinement run');
        return {
            artifactRoot,
            baseline: path.join(artifactRoot, 'baseline'),
        };
    }

    writeRollout(artifactRoot, rolloutId, record, batchId = null) {
        const root = batchId
            ? path.join(artifactRoot, 'batches', this._segment(batchId, 'batchId'), 'rollouts')
            : path.join(artifactRoot, 'rollouts');
        this._writeJson(
            path.join(root, this._segment(rolloutId, 'rolloutId'), 'record.json'),
            record
        );
    }

    writeCandidate(artifactRoot, content) {
        const candidatePath = path.join(artifactRoot, 'refined-skill.md');
        fs.writeFileSync(candidatePath, `${content.trim()}\n`, 'utf8');
        return candidatePath;
    }

    writeRawTrajectories(artifactRoot, records) {
        const evidencePath = path.join(artifactRoot, 'raw-rollout-trajectories.jsonl');
        const content = records.map(record => JSON.stringify(record)).join('\n');
        fs.writeFileSync(evidencePath, content ? `${content}\n` : '', 'utf8');
        return evidencePath;
    }

    appendRawTrajectories(artifactRoot, records) {
        const evidencePath = path.join(artifactRoot, 'raw-rollout-trajectories.jsonl');
        fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
        const content = records.map(record => JSON.stringify(record)).join('\n');
        if (content) fs.appendFileSync(evidencePath, `${content}\n`, 'utf8');
        else if (!fs.existsSync(evidencePath)) fs.writeFileSync(evidencePath, '', 'utf8');
        return evidencePath;
    }

    writeStep(artifactRoot, epoch, step, record) {
        const directory = path.join(
            artifactRoot,
            'steps',
            `epoch-${String(epoch).padStart(3, '0')}`,
            `step-${String(step).padStart(3, '0')}`
        );
        this._writeJson(path.join(directory, 'record.json'), record);
        return path.join(directory, 'record.json');
    }

    removeWorkspace(artifactRoot, workspace, metadata = {}) {
        if (!workspace) return false;
        const root = path.resolve(artifactRoot);
        const target = path.resolve(workspace);
        if (!pathIsInside(root, target) || target === root || path.basename(target) !== 'workspace') {
            throw new Error('Refusing to remove a rollout workspace outside its artifact root');
        }
        if (fs.existsSync(target)) {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) {
                throw new Error('Refusing to remove a symbolic-link rollout workspace');
            }
            const realRoot = fs.realpathSync(root);
            const realTarget = fs.realpathSync(target);
            if (!pathIsInside(realRoot, realTarget)) {
                throw new Error('Refusing to remove a rollout workspace that escaped its artifact root');
            }
        }
        fs.rmSync(target, { recursive: true, force: true });
        const retentionPath = path.join(root, 'workspace-retention.jsonl');
        fs.appendFileSync(retentionPath, `${JSON.stringify({
            schemaVersion: 1,
            recordType: 'workspace-removed',
            createdAt: new Date().toISOString(),
            workspace: target,
            ...metadata,
        })}\n`, 'utf8');
        return true;
    }

    writeEvidence(artifactRoot, records) {
        return this.writeRawTrajectories(artifactRoot, records);
    }

    writeResult(artifactRoot, result) {
        this._writeJson(path.join(artifactRoot, 'result.json'), result);
    }

    history(limit = 20) {
        const count = Math.min(Math.max(1, Number(limit) || 20), this.config.maxRuns);
        if (!fs.existsSync(this.runRoot)) return [];
        const runs = [];
        for (const entry of fs.readdirSync(this.runRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const resultPath = path.join(this.runRoot, entry.name, 'result.json');
            if (!fs.existsSync(resultPath)) continue;
            try {
                const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                if (result && result.run) runs.push(result.run);
            } catch {
                // Ignore incomplete or corrupt artifacts while listing other valid runs.
            }
        }
        return runs
            .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
            .slice(0, count);
    }

    result(runId) {
        if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/i.test(runId)) {
            throw new Error('runId is invalid');
        }
        const runDirectory = path.resolve(this.runRoot, runId);
        const root = path.resolve(this.runRoot);
        if (!pathIsInside(root, runDirectory)) throw new Error('runId escaped the run root');
        const resultPath = path.join(runDirectory, 'result.json');
        if (!fs.existsSync(resultPath)) throw new Error(`Unknown Skill Refinement run: ${runId}`);
        return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }

    _writeJson(file, value) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }

    _segment(value, label) {
        const segment = String(value || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) {
            throw new Error(`${label} is invalid`);
        }
        return segment;
    }
}

module.exports = { RefinementArtifactRepository };
