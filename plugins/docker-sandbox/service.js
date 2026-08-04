const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DockerClient } = require('./docker-client');
const { loadSuite, listSuites } = require('./suite');
const { runAgentRollout } = require('./training-runner');
const {
    normalizeConfig,
    sessionKey,
    clampTimeout,
    buildRunArgs,
} = require('./policy');

const STATE_VERSION = 2;
const SNAPSHOT_IGNORES = new Set(['.git', '.code', 'node_modules']);
const SNAPSHOT_SECRET_PATHS = new Set([
    'github/config.json',
    'model-providers/config.json',
    'search-providers/config.json',
]);
const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

function cleanResult(result) {
    return {
        ok: result.exitCode === 0 && !result.timedOut && !result.error,
        exitCode: result.exitCode,
        signal: result.signal,
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

function ensureContainedDirectory(root, candidate, label = 'Sandbox directory') {
    fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(path.resolve(root));
    fs.mkdirSync(candidate, { recursive: true });
    const realCandidate = fs.realpathSync(path.resolve(candidate));
    if (!pathIsInside(realRoot, realCandidate)) {
        throw new Error(`${label} escaped its configured root`);
    }
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
            throw new Error(`Training snapshots do not allow symbolic links: ${current}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(sourceRoot, real)) {
            throw new Error(`Training snapshot source escaped its root: ${current}`);
        }
        if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
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
            throw new Error('Training snapshot exceeded its file or byte limit');
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
            throw new Error(`Training workspaces do not allow symbolic links: ${relative || '.'}`);
        }
        const real = fs.realpathSync(current);
        if (!pathIsInside(realRoot, real)) {
            throw new Error(`Training workspace entry escaped its root: ${relative || '.'}`);
        }
        if (stat.isDirectory()) {
            const children = fs.readdirSync(current, { withFileTypes: true });
            for (const child of children) {
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

function trainingScore(evaluation, violations) {
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
        error: run.error || null,
    };
}

class DockerSandboxService {
    constructor(sessionId, config = {}, dependencies = {}) {
        this.sessionId = String(sessionId || 'anonymous');
        this.session = sessionKey(this.sessionId);
        this.config = normalizeConfig(config);
        this.client = dependencies.client || new DockerClient({ command: this.config.command });
        this.model = dependencies.model || null;
        this.rolloutExecutor = dependencies.rolloutExecutor || runAgentRollout;
        this.sessionRoot = path.join(this.config.sandboxRoot, this.session);
        this.workspace = path.join(this.sessionRoot, 'workspace');
        this.trainingRoot = path.join(this.sessionRoot, 'training-runs');
        this.executions = 0;
        this.trainingRuns = [];
        this.dirty = false;
        this._queue = Promise.resolve();
        this._activeContainers = new Set();
    }

    _ensureWorkspaceAt(workspace, label = 'Sandbox workspace') {
        return ensureContainedDirectory(this.config.sandboxRoot, workspace, label);
    }

    _serialize(task) {
        const next = this._queue.then(task, task);
        this._queue = next.catch(() => {});
        return next;
    }

    async status() {
        const version = await this.client.version({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
        if (version.error || version.exitCode !== 0) {
            return {
                available: false,
                imageReady: false,
                image: this.config.image,
                workspace: this.workspace,
                trainingRoot: this.trainingRoot,
                suites: listSuites(this.config.suitesRoot, this.config.projectRoot),
                error: version.error || version.stderr || 'Docker Engine is unavailable',
            };
        }
        const image = await this.client.inspectImage(this.config.image, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        });
        return {
            available: true,
            version: (version.stdout || '').trim(),
            imageReady: image.exitCode === 0 && !image.error,
            image: this.config.image,
            imageId: image.exitCode === 0 ? (image.stdout || '').trim() : null,
            workspace: this.workspace,
            trainingRoot: this.trainingRoot,
            network: this.config.network,
            suites: listSuites(this.config.suitesRoot, this.config.projectRoot),
            recentTrainingRuns: this.trainingRuns.slice(-5).map(summarizeRun).reverse(),
        };
    }

    async _executeAtWorkspace(args, workspace, metadata = {}) {
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) throw new Error('command is required');
        if (command.length > 32768) throw new Error('command exceeds the 32768 character limit');
        const realWorkspace = this._ensureWorkspaceAt(workspace);
        const suffix = metadata.rolloutId ? `-${metadata.rolloutId}` : '';
        const containerName = `codeagent-sbx-${this.session}${suffix}-${crypto.randomUUID().slice(0, 8)}`;
        const timeoutMs = clampTimeout(args.timeoutMs, this.config);
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
                timeoutMs,
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
        this.executions += 1;
        this.dirty = true;
        return {
            ...cleanResult(result),
            purpose: metadata.purpose || (args.purpose === 'evaluation' ? 'evaluation' : 'work'),
            execution: this.executions,
            runId: metadata.runId || null,
            rolloutId: metadata.rolloutId || null,
        };
    }

    execute(args = {}) {
        return this._serialize(() => this._executeAtWorkspace(args, this.workspace));
    }

    listTrainingSuites() {
        return listSuites(this.config.suitesRoot, this.config.projectRoot);
    }

    startTraining(args = {}) {
        return this._serialize(async () => {
            const suite = loadSuite(
                this.config.suitesRoot,
                args.suiteId,
                this.config.projectRoot
            );
            if (!this.model && this.rolloutExecutor === runAgentRollout) {
                throw new Error('Training rollouts require the host model service');
            }

            const runId = crypto.randomUUID();
            const artifactRoot = path.join(this.trainingRoot, runId);
            const baseline = path.join(artifactRoot, 'baseline');
            this._ensureWorkspaceAt(artifactRoot, 'Training run');
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
                error: null,
            };
            this.trainingRuns.push(run);
            if (this.trainingRuns.length > this.config.maxTrainingRuns) {
                this.trainingRuns.splice(0, this.trainingRuns.length - this.config.maxTrainingRuns);
            }
            this.dirty = true;

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
                run.status = 'completed';
                run.bestRolloutId = best ? best.id : null;
                run.bestScore = best ? best.score : null;
                run.finishedAt = new Date().toISOString();

                const skillOptRecords = rollouts.map((rollout) => JSON.stringify({
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
                fs.writeFileSync(
                    path.join(artifactRoot, 'skillopt-rollouts.jsonl'),
                    skillOptRecords ? `${skillOptRecords}\n` : '',
                    'utf8'
                );

                const result = {
                    schemaVersion: 1,
                    run: summarizeRun(run),
                    suite: {
                        id: suite.id,
                        task: suite.task,
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
                    ranking: ranking.map((item) => ({
                        rolloutId: item.id,
                        score: item.score,
                        evaluationPassed: item.evaluation.ok,
                        protectedPathViolations: item.protectedPathViolations,
                        changedFiles: item.diff.fileCount,
                        changedBytes: item.diff.changedBytes,
                    })),
                    skillOptInput: path.join(artifactRoot, 'skillopt-rollouts.jsonl'),
                };
                fs.writeFileSync(
                    path.join(artifactRoot, 'result.json'),
                    `${JSON.stringify(result, null, 2)}\n`,
                    'utf8'
                );
                this.dirty = true;
                return result;
            } catch (error) {
                run.status = 'failed';
                run.error = error.message;
                run.finishedAt = new Date().toISOString();
                this.dirty = true;
                fs.writeFileSync(
                    path.join(artifactRoot, 'result.json'),
                    `${JSON.stringify({ schemaVersion: 1, run: summarizeRun(run) }, null, 2)}\n`,
                    'utf8'
                );
                throw error;
            }
        });
    }

    async _runRollout({ runId, rolloutIndex, suite, artifactRoot, baseline }) {
        const id = `rollout-${String(rolloutIndex + 1).padStart(3, '0')}`;
        const workspace = path.join(artifactRoot, 'rollouts', id, 'workspace');
        this._ensureWorkspaceAt(path.dirname(workspace), 'Training rollout');
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
                executeCommand: (commandArgs) => this._executeAtWorkspace(
                    commandArgs,
                    workspace,
                    { runId, rolloutId: id, purpose: 'training-work' }
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
                purpose: 'training-evaluation',
                runId,
                rolloutId: id,
            };
        } else {
            evaluation = await this._executeAtWorkspace(
                { command: suite.evaluation.command, timeoutMs: suite.evaluation.timeoutMs },
                workspace,
                { runId, rolloutId: id, purpose: 'training-evaluation' }
            );
        }
        const diff = diffTrees(baseline, workspace);
        const score = trainingScore(evaluation, violations);
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

    trainingHistory(limit = 20) {
        const count = Math.min(Math.max(1, Number(limit) || 20), this.config.maxTrainingRuns);
        return this.trainingRuns.slice(-count).reverse().map(summarizeRun);
    }

    trainingResult(runId) {
        const run = this.trainingRuns.find((item) => item.id === runId);
        if (!run) throw new Error(`Unknown training run: ${runId}`);
        const resultPath = path.join(run.artifactRoot, 'result.json');
        if (!fs.existsSync(resultPath)) return { run: summarizeRun(run), result: null };
        return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }

    reset() {
        return this._serialize(async () => {
            const root = path.resolve(this.config.sandboxRoot);
            const sessionRoot = path.resolve(this.sessionRoot);
            if (!pathIsInside(root, sessionRoot) || sessionRoot === root) {
                throw new Error('Refusing to reset a workspace outside the sandbox root');
            }
            fs.rmSync(sessionRoot, { recursive: true, force: true });
            this.executions = 0;
            this.trainingRuns = [];
            this.dirty = true;
            return { reset: true, workspace: this.workspace, trainingRoot: this.trainingRoot };
        });
    }

    hydrate(raw) {
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope || !envelope.data || ![1, STATE_VERSION].includes(envelope.version)) {
            throw new Error('Invalid docker-sandbox state envelope');
        }
        this.executions = Number.isInteger(envelope.data.executions) ? envelope.data.executions : 0;
        this.trainingRuns = envelope.version >= 2 && Array.isArray(envelope.data.trainingRuns)
            ? envelope.data.trainingRuns.slice(-this.config.maxTrainingRuns)
            : [];
        this.dirty = false;
    }

    serialize() {
        return JSON.stringify({
            name: 'docker-sandbox',
            version: STATE_VERSION,
            data: {
                session: this.session,
                executions: this.executions,
                trainingRuns: this.trainingRuns.map(summarizeRun),
            },
        });
    }

    async dispose() {
        const names = [...this._activeContainers];
        await Promise.all(names.map((name) => this.client.removeContainer(name, {
            timeoutMs: 5000,
            maxOutputBytes: 64 * 1024,
        })));
        this._activeContainers.clear();
    }
}

module.exports = {
    DockerSandboxService,
    cleanResult,
    ensureContainedDirectory,
    copySnapshot,
    scanTree,
    diffTrees,
    protectedViolations,
    trainingScore,
    rankRollouts,
};
