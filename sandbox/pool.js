const crypto = require('node:crypto');
const path = require('node:path');
const {
    byteSize,
    buildPersistentContainerArgs,
    clampTimeout,
} = require('./policy');
const { ensureContainedDirectory } = require('./workspace');

const DIAGNOSTIC_OPTIONS = Object.freeze({ timeoutMs: 10000, maxOutputBytes: 128 * 1024 });

function sandboxError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function assertDockerOperation(result, code, fallback) {
    if (!result || (!result.error && (result.exitCode === undefined || result.exitCode === 0))) {
        return result;
    }
    throw sandboxError(code, result.error || result.stderr || fallback, { result });
}

function classifyResult(result = {}) {
    const text = `${result.error || ''}\n${result.stderr || ''}`.toLowerCase();
    if (result.timedOut) return 'timeout';
    if (result.oomKilled || result.exitCode === 137 || /out of memory|oomkilled/.test(text)) {
        return 'oom';
    }
    if (result.error || result.exitCode === null) return 'infrastructure';
    return result.exitCode === 0 ? 'success' : 'task';
}

class SandboxLease {
    constructor(pool, fields) {
        this.pool = pool;
        this.id = fields.id;
        this.containerName = fields.containerName;
        this.snapshot = fields.snapshot;
        this.metadata = Object.freeze({ ...(fields.metadata || {}) });
        this.closed = false;
        this._queue = Promise.resolve();
    }

    exec(args = {}) {
        const task = () => this._exec(args);
        const result = this._queue.then(task, task);
        this._queue = result.catch(() => {});
        return result;
    }

    async _exec(args) {
        if (this.closed) throw sandboxError('SANDBOX_CLOSED', 'Sandbox lease is closed');
        const command = typeof args.command === 'string' ? args.command.trim() : '';
        if (!command) throw new Error('command is required');
        if (command.length > 32768) throw new Error('command exceeds the 32768 character limit');

        return this.pool._withActiveSlot(async () => {
            await this.pool._ensureDiskCapacity();
            assertDockerOperation(
                await this.pool.client.startContainer(this.containerName, DIAGNOSTIC_OPTIONS),
                'SANDBOX_START_FAILED',
                'Failed to start sandbox container'
            );
            let result;
            try {
                result = await this.pool.client.execContainer(
                    this.containerName,
                    command,
                    {
                        timeoutMs: clampTimeout(args.timeoutMs, this.pool.config),
                        maxOutputBytes: this.pool.config.maxOutputBytes,
                    }
                );
                const state = await this.pool.client.inspectContainerState(
                    this.containerName,
                    DIAGNOSTIC_OPTIONS
                );
                if (state?.error) {
                    throw sandboxError(
                        'SANDBOX_INSPECT_FAILED',
                        state.error,
                        { result: state.result || null }
                    );
                }
                result = { ...result, oomKilled: Boolean(state.oomKilled) };
            } finally {
                assertDockerOperation(
                    await this.pool.client.stopContainer(this.containerName, DIAGNOSTIC_OPTIONS),
                    'SANDBOX_STOP_FAILED',
                    'Failed to stop sandbox container'
                );
            }
            const failureType = classifyResult(result);
            if (failureType === 'oom') this.pool.reduceConcurrency();
            return {
                ...result,
                ok: failureType === 'success',
                failureType,
                leaseId: this.id,
                metadata: this.metadata,
            };
        });
    }

    async exportWorkspace(destination) {
        if (this.closed) throw sandboxError('SANDBOX_CLOSED', 'Sandbox lease is closed');
        const target = ensureContainedDirectory(
            this.pool.config.sandboxRoot,
            destination,
            'Sandbox export'
        );
        assertDockerOperation(
            await this.pool.client.copyFromContainer(
                this.containerName,
                '/workspace/.',
                target,
                DIAGNOSTIC_OPTIONS
            ),
            'SANDBOX_EXPORT_FAILED',
            'Failed to export sandbox workspace'
        );
        return target;
    }

    async dispose() {
        if (this.closed) return;
        await this._queue.catch(() => {});
        assertDockerOperation(
            await this.pool.client.removeContainer(this.containerName, DIAGNOSTIC_OPTIONS),
            'SANDBOX_REMOVE_FAILED',
            'Failed to remove sandbox container'
        );
        this.closed = true;
        this.pool._leases.delete(this);
    }
}

class SandboxPool {
    constructor(config, dependencies = {}) {
        if (!config) throw new Error('SandboxPool config is required');
        if (!dependencies.client) throw new Error('SandboxPool Docker client is required');
        this.config = config;
        this.client = dependencies.client;
        this.session = String(dependencies.session || 'anonymous');
        this.limit = config.maxActive;
        this.active = 0;
        this.peakActive = 0;
        this._waiters = [];
        this._leases = new Set();
        this._snapshots = new Set();
        this._disposed = false;
        this._initialized = false;
        this._diskUsage = null;
        this._diskCheckedAt = 0;
        this._diskCheckPromise = null;
        this._diskCheckIntervalMs = dependencies.diskCheckIntervalMs === undefined
            ? 1000
            : Math.max(0, Number(dependencies.diskCheckIntervalMs) || 0);
    }

    async initialize() {
        const info = typeof this.client.engineInfo === 'function'
            ? await this.client.engineInfo(DIAGNOSTIC_OPTIONS)
            : null;
        const reservation = byteSize(this.config.memoryReservation);
        if (info && info.memoryBytes && reservation) {
            const budget = Math.floor(info.memoryBytes * this.config.engineMemoryFraction);
            const memoryLimit = Math.max(1, Math.floor(budget / reservation));
            this.limit = this._initialized
                ? Math.min(this.limit, memoryLimit)
                : Math.min(this.config.maxActive, memoryLimit);
        }
        this._initialized = true;
        return this.stats();
    }

    async status() {
        const version = await this.client.version(DIAGNOSTIC_OPTIONS);
        const available = !version.error && version.exitCode === 0;
        let imageReady = false;
        let imageId = null;
        if (available) {
            const image = await this.client.inspectImage(this.config.image, DIAGNOSTIC_OPTIONS);
            imageReady = image.exitCode === 0 && !image.error;
            imageId = imageReady ? String(image.stdout || '').trim() : null;
            await this.initialize();
        }
        return {
            available,
            version: available ? String(version.stdout || '').trim() : null,
            imageReady,
            image: this.config.image,
            imageId,
            pool: this.stats(),
            resources: this.resourcePolicy(),
            error: available ? null : (version.error || version.stderr || 'Docker Engine is unavailable'),
        };
    }

    async prepareSnapshot({ source, snapshotId } = {}) {
        if (this._disposed) throw sandboxError('SANDBOX_POOL_CLOSED', 'Sandbox pool is closed');
        if (!this._initialized) await this.initialize();
        await this._ensureDiskCapacity();
        const root = ensureContainedDirectory(this.config.sandboxRoot, source, 'Sandbox snapshot');
        const id = snapshotId || crypto.randomUUID();
        const safeId = crypto.createHash('sha256').update(`${this.session}:${id}`).digest('hex').slice(0, 24);
        const image = `codeagent-snapshot:${safeId}`;
        assertDockerOperation(
            await this.client.buildSnapshotImage({
                baseImage: this.config.image,
                context: root,
                image,
                user: this.config.user,
            }, { timeoutMs: this.config.maxTimeoutMs, maxOutputBytes: this.config.maxOutputBytes }),
            'SANDBOX_SNAPSHOT_BUILD_FAILED',
            'Failed to build sandbox snapshot image'
        );
        const snapshot = Object.freeze({ id, image, source: path.resolve(root) });
        this._snapshots.add(snapshot);
        return snapshot;
    }

    async acquire(snapshot, metadata = {}) {
        if (this._disposed) throw sandboxError('SANDBOX_POOL_CLOSED', 'Sandbox pool is closed');
        if (!this._initialized) await this.initialize();
        if (!snapshot || !this._snapshots.has(snapshot)) {
            throw new Error('Sandbox snapshot does not belong to this pool');
        }
        await this._ensureDiskCapacity();
        const id = crypto.randomUUID();
        const containerName = `codeagent-pool-${this.session}-${id.slice(0, 8)}`;
        const args = buildPersistentContainerArgs({
            config: this.config,
            containerName,
            session: this.session,
            image: snapshot.image,
        });
        const created = await this.client.createContainer(args, DIAGNOSTIC_OPTIONS);
        if (created && (created.error || created.exitCode !== 0)) {
            throw sandboxError(
                'SANDBOX_CREATE_FAILED',
                created.error || created.stderr || 'Failed to create sandbox container'
            );
        }
        const lease = new SandboxLease(this, { id, containerName, snapshot, metadata });
        this._leases.add(lease);
        return lease;
    }

    async _currentDiskUsage() {
        const now = Date.now();
        if (this._diskCheckedAt > 0
            && now - this._diskCheckedAt < this._diskCheckIntervalMs) {
            return this._diskUsage;
        }
        if (this._diskCheckPromise) return this._diskCheckPromise;
        this._diskCheckPromise = Promise.resolve(
            this.client.diskUsage(DIAGNOSTIC_OPTIONS)
        ).then(disk => {
            this._diskUsage = disk;
            this._diskCheckedAt = Date.now();
            return disk;
        }).finally(() => {
            this._diskCheckPromise = null;
        });
        return this._diskCheckPromise;
    }

    async _ensureDiskCapacity() {
        if (typeof this.client.diskUsage !== 'function') return;
        const disk = await this._currentDiskUsage();
        if (disk && Number.isFinite(disk.fractionUsed)
            && disk.fractionUsed >= this.config.diskHighWatermark) {
            throw sandboxError(
                'SANDBOX_DISK_PRESSURE',
                'Docker disk high-water mark reached',
                { disk }
            );
        }
    }

    reduceConcurrency() {
        this.limit = Math.max(1, Math.floor(this.limit / 2));
        this._drain();
        return this.limit;
    }

    async _withActiveSlot(task) {
        await this._enter();
        try {
            return await task();
        } finally {
            this.active -= 1;
            this._drain();
        }
    }

    _enter() {
        if (this.active < this.limit) {
            this.active += 1;
            this.peakActive = Math.max(this.peakActive, this.active);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
    }

    _drain() {
        while (!this._disposed && this.active < this.limit && this._waiters.length > 0) {
            const waiter = this._waiters.shift();
            this.active += 1;
            this.peakActive = Math.max(this.peakActive, this.active);
            waiter.resolve();
        }
    }

    stats() {
        return Object.freeze({
            limit: this.limit,
            active: this.active,
            queued: this._waiters.length,
            leases: this._leases.size,
            snapshots: this._snapshots.size,
            peakActive: this.peakActive,
        });
    }

    resourcePolicy() {
        return Object.freeze({
            configuredMaxActive: this.config.maxActive,
            effectiveMaxActive: this.limit,
            hardMemory: this.config.memory,
            memoryReservation: this.config.memoryReservation,
            engineMemoryFraction: this.config.engineMemoryFraction,
            writableLayerSize: this.config.writableLayerSize,
            diskHighWatermark: this.config.diskHighWatermark,
            network: this.config.network,
        });
    }

    async disposeSnapshot(snapshot) {
        if (!this._snapshots.has(snapshot)) return;
        if ([...this._leases].some(lease => lease.snapshot === snapshot)) {
            throw new Error('Cannot remove a snapshot while leases still use it');
        }
        assertDockerOperation(
            await this.client.removeImage(snapshot.image, DIAGNOSTIC_OPTIONS),
            'SANDBOX_SNAPSHOT_REMOVE_FAILED',
            'Failed to remove sandbox snapshot image'
        );
        this._snapshots.delete(snapshot);
    }

    async dispose() {
        if (this._disposed) return;
        this._disposed = true;
        const error = sandboxError('SANDBOX_POOL_CLOSED', 'Sandbox pool is closed');
        for (const waiter of this._waiters.splice(0)) waiter.reject(error);
        await Promise.allSettled([...this._leases].map(lease => lease.dispose()));
        await Promise.allSettled([...this._snapshots].map(snapshot => this.client.removeImage(
            snapshot.image,
            DIAGNOSTIC_OPTIONS
        )));
        this._snapshots.clear();
    }
}

module.exports = {
    SandboxPool,
    SandboxLease,
    classifyResult,
    sandboxError,
    DIAGNOSTIC_OPTIONS,
    assertDockerOperation,
};
