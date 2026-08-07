const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DockerClient } = require('../sandbox/docker-client');
const {
    normalizeSandboxConfig,
    positiveInteger,
    sessionKey,
    clampTimeout,
    buildRunArgs,
} = require('../sandbox/policy');
const { loadSuite, listSuites } = require('./suite');
const { runSkillRollout } = require('./rollout-runner');
const { refineSkill } = require('./refiner');

const SNAPSHOT_IGNORES = new Set(['.git', '.code', 'node_modules']);
const SNAPSHOT_SECRET_PATHS = new Set([
    'github/config.json',
    'model-providers/config.json',
    'search-providers/config.json',
]);
const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

function normalizeConfig(config = {}) {
    const sandbox = normalizeSandboxConfig(config);
    const projectRoot = path.resolve(config.projectRoot || process.cwd());
    return Object.freeze({
        ...sandbox,
        projectRoot,
        suitesRoot: path.resolve(
            config.suitesRoot || path.join(projectRoot, 'skill-refinement', 'suites')
        ),
        maxRuns: positiveInteger(config.maxRuns, 20),
    });
}

function cleanResult(result) {
    return {
        ok: result.exitCode === 0 && !result.timedOut && !result.error,
        exitCode: result.exitCode,
        signal: result.signal || null,
        timedOut: Boolean(result.timedOut),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        truncated: Boolean(result.truncated),
        error: result.error || null,
        errorCode: result.errorCode || null,
        durationMs: result.durationMs,
    };
}

function pathIsInside(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function ensureContainedDirectory(root, candidate, label = 'Skill Refinement directory') {
    fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(path.resolve(root));
    fs.mkdirSync(candidate, { recursive: true });
    const realCandidate = fs.realpathSync(path.resolve(candidate));
    if (!pathIsInside(realRoot, realCandidate)) throw new Error(`${label} escaped its configured root`);
    return realCandidate;
}

function copySnapshot(source, destination) {
    const sourceRoot = fs.realpathSync(path.resolve(source));
    fs.mkdirSync(destination, { recursive: true });
    let files = 0;
    let bytes = 0;

    function ignored(relative, depth, name) {
        const portable = relative.split(path.sep).join('/');
        if (depth === 0 && SNAPSHOT_IGNORES.has(name)) return true;
        if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') return true;
        return SNAPSHOT_SECRET_PATHS.has(portable);
    }

    function visit(current, target, depth) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`Skill Refinement snapshots do not allow symbolic links: ${current}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(sourceRoot, real)) {
            throw new Error(`Skill Refinement snapshot source escaped its root: ${current}`);
        }
        if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const relative = path.relative(sourceRoot, path.join(current, entry.name));
                if (ignored(relative, depth, entry.name)) continue;
                visit(path.join(current, entry.name), path.join(target, entry.name), depth + 1);
            }
            return;
        }
        if (!stat.isFile()) throw new Error(`Unsupported snapshot entry: ${current}`);
        files += 1;
        bytes += stat.size;
        if (files > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
            throw new Error('Skill Refinement snapshot exceeded its file or byte limit');
        }
        fs.copyFileSync(current, target);
    }

    visit(sourceRoot, destination, 0);
    return { files, bytes };
}

function fileHash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function scanTree(root) {
    const entries = new Map();
    if (!fs.existsSync(root)) return entries;
    const realRoot = fs.realpathSync(path.resolve(root));

    function visit(current, relative, depth) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
            throw new Error(`Skill Refinement workspaces do not allow symbolic links: ${relative || '.'}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(realRoot, real)) {
            throw new Error(`Skill Refinement workspace entry escaped its root: ${relative || '.'}`);
        }
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(current, { withFileTypes: true })) {
                if (depth === 0 && SNAPSHOT_IGNORES.has(child.name)) continue;
                const childRelative = relative ? path.join(relative, child.name) : child.name;
                visit(path.join(current, child.name), childRelative, depth + 1);
            }
            return;
        }
        if (!stat.isFile()) throw new Error(`Unsupported workspace entry: ${relative}`);
        entries.set(relative.split(path.sep).join('/'), {
            hash: fileHash(current),
            bytes: stat.size,
        });
    }

    visit(realRoot, '', 0);
    return entries;
}

function diffTrees(baseline, workspace) {
    const before = scanTree(baseline);
    const after = scanTree(workspace);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const files = [];
    let changedBytes = 0;
    for (const name of names) {
        const left = before.get(name) || null;
        const right = after.get(name) || null;
        if (left && right && left.hash === right.hash) continue;
        const status = !left ? 'added' : (!right ? 'deleted' : 'modified');
        changedBytes += Math.max(left ? left.bytes : 0, right ? right.bytes : 0);
        files.push({
            path: name,
            status,
            beforeHash: left ? left.hash : null,
            afterHash: right ? right.hash : null,
            beforeBytes: left ? left.bytes : 0,
            afterBytes: right ? right.bytes : 0,
        });
    }
    return { files, fileCount: files.length, changedBytes };
}

function entityDigest(root, relative) {
    const target = path.resolve(root, relative);
    const resolvedRoot = path.resolve(root);
    if (!pathIsInside(resolvedRoot, target)) throw new Error('Protected path escaped the project');
    if (!fs.existsSync(target)) return null;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { type: 'symlink' };
    if (stat.isFile()) return { type: 'file', hash: fileHash(target), bytes: stat.size };
    if (!stat.isDirectory()) return { type: 'unsupported' };
    const entries = [...scanTree(target).entries()];
    return {
        type: 'directory',
        hash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
        files: entries.length,
    };
}

function protectedViolations(baseline, workspace, protectedPaths) {
    const violations = [];
    for (const relative of protectedPaths) {
        const before = entityDigest(baseline, relative);
        const after = entityDigest(workspace, relative);
        if (JSON.stringify(before) !== JSON.stringify(after)) violations.push(relative);
    }
    return violations;
}

function refinementScore(evaluation, violations) {
    if (violations.length > 0) return -1;
    return evaluation && evaluation.ok ? 1 : 0;
}

function rankRollouts(left, right) {
    if (left.score !== right.score) return right.score - left.score;
    if (left.diff.changedBytes !== right.diff.changedBytes) {
        return left.diff.changedBytes - right.diff.changedBytes;
    }
    const leftDuration = left.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    const rightDuration = right.evaluation.durationMs || Number.MAX_SAFE_INTEGER;
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    return left.id.localeCompare(right.id);
}

function summarizeRun(run) {
    return {
        id: run.id,
        suiteId: run.suiteId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        rolloutCount: run.rolloutCount,
        bestRolloutId: run.bestRolloutId || null,
        bestScore: Number.isFinite(run.bestScore) ? run.bestScore : null,
        artifactRoot: run.artifactRoot,
        candidateSkillPath: run.candidateSkillPath || null,
        error: run.error || null,
    };
}

class SkillRefinementService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeConfig(config);
        this.client = dependencies.client || new DockerClient({ command: this.config.command });
        this.model = dependencies.model || null;
        this.rolloutExecutor = dependencies.rolloutExecutor || runSkillRollout;
        this.skillRefiner = dependencies.skillRefiner || refineSkill;
        this.runRoot = path.join(
            this.config.sandboxRoot,
            this.session,
            'skill-refinement-runs'
        );
        this._activeContainers = new Set();
    }

    _ensureDirectory(candidate, label) {
        return ensureContainedDirectory(this.config.sandboxRoot, candidate, label);
    }

    async status() {
        const version = await this.client.version({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
        const available = !version.error && version.exitCode === 0;
        let imageReady = false;
        let imageId = null;
        if (available) {
            const image = await this.client.inspectImage(this.config.image, {
                timeoutMs: 5000,
                maxOutputBytes: 64 * 1024,
            });
            imageReady = image.exitCode === 0 && !image.error;
            imageId = imageReady ? (image.stdout || '').trim() : null;
        }
        return {
            available,
            version: available ? (version.stdout || '').trim() : null,
            imageReady,
            image: this.config.image,
            imageId,
            suites: this.listSuites(),
            runRoot: this.runRoot,
            recentRuns: this.history(5),
            error: available ? null : (version.error || version.stderr || 'Docker Engine is unavailable'),
        };
    }

    listSuites() {
        return listSuites(this.config.suitesRoot, this.config.projectRoot);
    }

    async _executeAtWorkspace(args, workspace, metadata) {
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) throw new Error('command is required');
        if (command.length > 32768) throw new Error('command exceeds the 32768 character limit');
        const realWorkspace = this._ensureDirectory(workspace, 'Skill Refinement rollout workspace');
        const containerName = `codeagent-refine-${this.session}-${metadata.rolloutId}-${crypto.randomUUID().slice(0, 8)}`;
        const dockerArgs = buildRunArgs({
            config: this.config,
            containerName,
            session: this.session,
            workspace: realWorkspace,
            command,
        });
        this._activeContainers.add(containerName);
        let result;
        try {
            result = await this.client.run(dockerArgs, {
                timeoutMs: clampTimeout(args.timeoutMs, this.config),
                maxOutputBytes: this.config.maxOutputBytes,
            });
        } finally {
            this._activeContainers.delete(containerName);
        }
        if (result.timedOut) {
            await this.client.removeContainer(containerName, {
                timeoutMs: 5000,
                maxOutputBytes: 64 * 1024,
            });
        }
        return { ...cleanResult(result), ...metadata };
    }

    async refine(args = {}) {
        const suite = loadSuite(this.config.suitesRoot, args.suiteId, this.config.projectRoot);
        if (!this.model && this.rolloutExecutor === runSkillRollout) {
            throw new Error('Skill Refinement requires the host model capability');
        }
        if ((!this.model || typeof this.model.complete !== 'function') && this.skillRefiner === refineSkill) {
            throw new Error('Skill Refinement synthesis requires the host model complete() capability');
        }

        const runId = crypto.randomUUID();
        const artifactRoot = path.join(this.runRoot, runId);
        const baseline = path.join(artifactRoot, 'baseline');
        this._ensureDirectory(artifactRoot, 'Skill Refinement run');
        const snapshot = copySnapshot(suite.baseline, baseline);
        const run = {
            id: runId,
            suiteId: suite.id,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            rolloutCount: suite.rollouts,
            bestRolloutId: null,
            bestScore: null,
            artifactRoot,
            candidateSkillPath: null,
            error: null,
        };

        try {
            const rollouts = await Promise.all(
                Array.from({ length: suite.rollouts }, (_, index) => this._runRollout({
                    runId,
                    rolloutIndex: index,
                    suite,
                    artifactRoot,
                    baseline,
                }))
            );
            const ranking = [...rollouts].sort(rankRollouts);
            const best = ranking[0] || null;
            const candidateSkill = await this.skillRefiner({
                model: this.model,
                suite,
                rollouts: ranking,
            });
            const candidateSkillPath = path.join(artifactRoot, 'refined-skill.md');
            fs.writeFileSync(candidateSkillPath, `${candidateSkill.trim()}\n`, 'utf8');

            run.status = 'completed';
            run.bestRolloutId = best ? best.id : null;
            run.bestScore = best ? best.score : null;
            run.candidateSkillPath = candidateSkillPath;
            run.finishedAt = new Date().toISOString();

            const records = rollouts.map(rollout => JSON.stringify({
                schemaVersion: 1,
                id: rollout.id,
                runId,
                suiteId: suite.id,
                task: suite.task,
                skill: suite.skill,
                messages: rollout.messages,
                finalReply: rollout.reply,
                evaluation: rollout.evaluation,
                protectedPathViolations: rollout.protectedPathViolations,
                diff: rollout.diff,
                reward: rollout.score,
            })).join('\n');
            const evidencePath = path.join(artifactRoot, 'refinement-rollouts.jsonl');
            fs.writeFileSync(evidencePath, records ? `${records}\n` : '', 'utf8');

            const result = {
                schemaVersion: 1,
                run: summarizeRun(run),
                suite: {
                    id: suite.id,
                    task: suite.task,
                    sourceSkillPath: suite.skillPath,
                    evaluationCommand: suite.evaluation.command,
                    protectedPaths: [...suite.protectedPaths],
                },
                snapshot,
                best: best ? {
                    rolloutId: best.id,
                    score: best.score,
                    workspace: best.workspace,
                    evaluation: best.evaluation,
                    diff: best.diff,
                    reply: best.reply,
                } : null,
                ranking: ranking.map(item => ({
                    rolloutId: item.id,
                    score: item.score,
                    evaluationPassed: item.evaluation.ok,
                    protectedPathViolations: item.protectedPathViolations,
                    changedFiles: item.diff.fileCount,
                    changedBytes: item.diff.changedBytes,
                })),
                candidateSkill: {
                    path: candidateSkillPath,
                    content: candidateSkill,
                },
                evidencePath,
            };
            fs.writeFileSync(
                path.join(artifactRoot, 'result.json'),
                `${JSON.stringify(result, null, 2)}\n`,
                'utf8'
            );
            return result;
        } catch (error) {
            run.status = 'failed';
            run.error = error.message;
            run.finishedAt = new Date().toISOString();
            fs.writeFileSync(
                path.join(artifactRoot, 'result.json'),
                `${JSON.stringify({ schemaVersion: 1, run: summarizeRun(run) }, null, 2)}\n`,
                'utf8'
            );
            throw error;
        }
    }

    async _runRollout({ runId, rolloutIndex, suite, artifactRoot, baseline }) {
        const id = `rollout-${String(rolloutIndex + 1).padStart(3, '0')}`;
        const workspace = path.join(artifactRoot, 'rollouts', id, 'workspace');
        this._ensureDirectory(path.dirname(workspace), 'Skill Refinement rollout');
        copySnapshot(baseline, workspace);

        let reply = '';
        let messages = [];
        let agentError = null;
        try {
            const outcome = await this.rolloutExecutor({
                model: this.model,
                suite,
                runId,
                rolloutId: id,
                workspace,
                executeCommand: commandArgs => this._executeAtWorkspace(
                    commandArgs,
                    workspace,
                    { runId, rolloutId: id, purpose: 'skill-refinement-work' }
                ),
            });
            reply = outcome && outcome.reply ? String(outcome.reply) : '';
            messages = outcome && Array.isArray(outcome.messages) ? outcome.messages : [];
        } catch (error) {
            agentError = error.message;
        }

        const violations = protectedViolations(baseline, workspace, suite.protectedPaths);
        let evaluation;
        if (violations.length > 0) {
            evaluation = {
                ok: false,
                exitCode: null,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                truncated: false,
                error: `Protected paths changed: ${violations.join(', ')}`,
                errorCode: 'PROTECTED_PATH_CHANGED',
                durationMs: 0,
                purpose: 'skill-refinement-evaluation',
                runId,
                rolloutId: id,
            };
        } else {
            evaluation = await this._executeAtWorkspace(
                { command: suite.evaluation.command, timeoutMs: suite.evaluation.timeoutMs },
                workspace,
                { runId, rolloutId: id, purpose: 'skill-refinement-evaluation' }
            );
        }
        const diff = diffTrees(baseline, workspace);
        const score = refinementScore(evaluation, violations);
        const record = {
            id,
            runId,
            workspace,
            reply,
            messages,
            agentError,
            evaluation,
            protectedPathViolations: violations,
            diff,
            score,
        };
        fs.writeFileSync(
            path.join(artifactRoot, 'rollouts', id, 'record.json'),
            `${JSON.stringify(record, null, 2)}\n`,
            'utf8'
        );
        return record;
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

    async dispose() {
        const names = [...this._activeContainers];
        await Promise.all(names.map(name => this.client.removeContainer(name, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        })));
        this._activeContainers.clear();
    }
}

module.exports = {
    SkillRefinementService,
    normalizeConfig,
    cleanResult,
    ensureContainedDirectory,
    copySnapshot,
    scanTree,
    diffTrees,
    protectedViolations,
    refinementScore,
    rankRollouts,
};
