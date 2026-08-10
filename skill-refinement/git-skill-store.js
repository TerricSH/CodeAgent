const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('../sandbox/docker-client');
const { pathIsInside } = require('../sandbox/workspace');

const GIT_TIMEOUT_MS = 30000;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

class GitSkillStore {
    constructor(artifactRoot, options = {}) {
        this.artifactRoot = path.resolve(artifactRoot);
        this.root = path.join(this.artifactRoot, 'skill-worktree');
        this.skillPath = path.join(this.root, 'SKILL.md');
        this.command = options.command || 'git';
        this.initialized = false;
    }

    async _git(args, options = {}) {
        const result = await runProcess(this.command, args, {
            cwd: this.root,
            timeoutMs: options.timeoutMs || GIT_TIMEOUT_MS,
            maxOutputBytes: options.maxOutputBytes || GIT_OUTPUT_LIMIT,
            env: {
                ...process.env,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
            },
        });
        if (result.error || result.exitCode !== 0) {
            const error = new Error(result.error || result.stderr || `git ${args[0]} failed`);
            error.code = result.errorCode || 'SKILL_GIT_FAILED';
            error.result = result;
            throw error;
        }
        return result;
    }

    async initialize(skill) {
        if (this.initialized) throw new Error('Skill Git store is already initialized');
        fs.mkdirSync(this.root, { recursive: true });
        fs.mkdirSync(path.join(this.root, '.disabled-git-hooks'), { recursive: true });
        fs.writeFileSync(this.skillPath, `${String(skill || '').trim()}\n`, 'utf8');
        await this._git(['init', '--quiet']);
        await this._git(['config', '--local', 'user.name', 'SkillOpt']);
        await this._git(['config', '--local', 'user.email', 'skillopt@local.invalid']);
        await this._git(['config', '--local', 'core.hooksPath', '.disabled-git-hooks']);
        await this._git(['config', '--local', 'core.autocrlf', 'false']);
        await this._git(['add', '--', 'SKILL.md']);
        await this._git(['commit', '--quiet', '-m', 'skillopt: baseline']);
        this.initialized = true;
        return this.head();
    }

    read() {
        if (!this.initialized) throw new Error('Skill Git store is not initialized');
        return fs.readFileSync(this.skillPath, 'utf8').trimEnd();
    }

    write(skill) {
        if (!this.initialized) throw new Error('Skill Git store is not initialized');
        fs.writeFileSync(this.skillPath, `${String(skill || '').trim()}\n`, 'utf8');
    }

    async diff() {
        return (await this._git(['diff', '--no-ext-diff', '--', 'SKILL.md'])).stdout || '';
    }

    async head() {
        return String((await this._git(['rev-parse', 'HEAD'])).stdout || '').trim();
    }

    async accept({ epoch, step, score }) {
        await this._git(['add', '--', 'SKILL.md']);
        await this._git([
            'commit', '--quiet', '-m',
            `skillopt: accept epoch=${epoch} step=${step} score=${score}`,
        ]);
        return this.head();
    }

    async restore() {
        await this._git(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'SKILL.md']);
        return this.read();
    }

    async exportHistory() {
        const historyPath = path.join(this.artifactRoot, 'skill-version-history.txt');
        const diffPath = path.join(this.artifactRoot, 'skill-version-diffs.patch');
        const history = await this._git([
            'log', '--reverse', '--date=iso-strict',
            '--pretty=format:%H%x09%P%x09%aI%x09%s', '--', 'SKILL.md',
        ]);
        const diffs = await this._git(['log', '--reverse', '--format=fuller', '-p', '--', 'SKILL.md']);
        fs.writeFileSync(historyPath, `${String(history.stdout || '').trim()}\n`, 'utf8');
        fs.writeFileSync(diffPath, String(diffs.stdout || ''), 'utf8');
        return { historyPath, diffPath, head: await this.head() };
    }

    dispose() {
        const gitDirectory = path.resolve(this.root, '.git');
        if (!pathIsInside(this.artifactRoot, gitDirectory) || gitDirectory === this.artifactRoot) {
            throw new Error('Refusing to clean a Skill Git directory outside its artifact root');
        }
        fs.rmSync(gitDirectory, { recursive: true, force: true });
        fs.rmSync(path.join(this.root, '.disabled-git-hooks'), { recursive: true, force: true });
        this.initialized = false;
    }
}

module.exports = { GitSkillStore, GIT_TIMEOUT_MS, GIT_OUTPUT_LIMIT };
