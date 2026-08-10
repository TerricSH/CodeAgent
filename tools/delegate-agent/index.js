const fs = require('node:fs');
const path = require('node:path');
const agents = require('../../agents');
const Output = require('../../renderers');
const providers = require('../../model-providers');
const { createModelCapability } = require('../../runtime/model-runtime');

const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const FORWARDED_CAPABILITIES = Object.freeze([
    'workspace',
    'fileSystem',
    'commandScope',
    'memoryScope',
    'sandboxScope',
]);

const capabilities = {
    required: ['workspace', 'fileSystem', 'commandScope'],
    optional: ['memoryScope', 'sandboxScope'],
};

function createSubagentCapabilities(parentCapabilities, ownCapabilities = {}) {
    const selected = { ...ownCapabilities };
    for (const name of FORWARDED_CAPABILITIES) {
        if (parentCapabilities && parentCapabilities[name] != null) {
            selected[name] = parentCapabilities[name];
        }
    }
    return Object.freeze(selected);
}

const definition = {
    type: 'function',
    function: {
        name: 'delegate_agent',
        description: `Delegate a bounded task to a specialized child Agent. Available Agents:\n${agents.listDescription()}`,
        parameters: {
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    description: 'Specialized Agent name.',
                    enum: agents.list().map(agent => agent.name),
                },
                task: { type: 'string', description: 'Bounded task for the child Agent.' },
                contextRefs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Explicit Context cache node IDs or sourceRefs to delegate.',
                },
                constraints: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Additional constraints that apply only to this delegation.',
                },
            },
            required: ['agent', 'task'],
        },
    },
};

function latestUserInstruction(context) {
    const latest = [...context.messages].reverse().find(message => message.role === 'user');
    return latest?.content || null;
}

function selectedContext(context, refs = []) {
    const requested = new Set(refs.map(String));
    return context.cache.entries.filter(entry =>
        requested.has(entry.id) || requested.has(entry.sourceRef)
    );
}

function toolFilter(agentConfig) {
    if (!agentConfig.tools) return () => true;
    return tool => {
        const name = tool?.definition?.function?.name;
        const separator = String(name).indexOf('__');
        const baseName = separator >= 0 ? String(name).slice(separator + 2) : name;
        return agentConfig.tools.includes(name) || agentConfig.tools.includes(baseName);
    };
}

function clipResult(content, maxCharacters = 12000) {
    const text = String(content || '');
    if (text.length <= maxCharacters) return { content: text, truncated: false };
    return {
        content: `${text.slice(0, maxCharacters)}\n[Full result available in the child Audit trace]`,
        truncated: true,
    };
}

async function handler(args, context, injectedCapabilities) {
    // Lazy imports keep the core Tool registry free of a tools -> runtime -> tools cycle.
    const runAgentLoop = require('../../agent-runner');
    const SessionRuntimeFactory = require('../../runtime/session-runtime-factory');
    const agentConfig = agents.get(args.agent);
    if (!agentConfig) return { status: 'failed', error: `Unknown Agent: ${args.agent}` };
    const selected = selectedContext(context, args.contextRefs || []);
    for (const entry of selected) context.touch(entry.id, 'delegated-to-subagent');

    const parentSessionId = context.sessionId;
    const rootSessionId = context.metadata?.rootSessionId || parentSessionId;
    const metadata = Object.freeze({
        type: 'subagent',
        agent: args.agent,
        parentSessionId,
        rootSessionId,
        depth: Number(context.metadata?.depth || 0) + 1,
        task: args.task,
    });
    const subOutput = new Output();
    const ref = agentConfig.model || null;
    const subClient = ref ? providers.resolve(ref) : providers.resolveDefault();
    const model = createModelCapability(subClient, ref);
    const forwarded = createSubagentCapabilities(injectedCapabilities);
    const factory = new SessionRuntimeFactory();
    const child = await factory.createChild({
        parentContext: context,
        workspaceRoot: context.metadata?.workspaceRoot,
        output: subOutput,
        model,
        basePrompt: agentConfig.prompt,
        metadata,
        capabilities: forwarded,
        toolFilter: toolFilter(agentConfig),
    });
    const delegationPackage = Object.freeze({
        task: String(args.task),
        currentUserInstruction: latestUserInstruction(context),
        constraints: Object.freeze((args.constraints || []).map(String)),
        sources: Object.freeze(selected.map(entry => Object.freeze({
            id: entry.id,
            kind: entry.kind,
            sourceRef: entry.sourceRef,
        }))),
    });
    const childTraceId = child.startTrace(JSON.stringify(delegationPackage), {
        parentSessionId,
        parentTraceId: context.auditWriter?.activeTraceId || null,
    }, {
        policySource: 'internal',
    });
    child.context.addUser(JSON.stringify(delegationPackage));
    for (const entry of selected) {
        child.context.load(entry.messages, {
            kind: entry.kind,
            sourceRef: entry.sourceRef,
            taskRef: childTraceId,
            metadata: { delegatedFrom: parentSessionId, parentCacheNodeId: entry.id },
        });
    }
    if (context.auditWriter) {
        context.auditWriter.record({
            eventType: 'subagent.started',
            actor: args.agent,
            spanId: childTraceId,
            parentSpanId: context.auditWriter.activeTraceId,
            content: args.task,
            payload: { childSessionId: child.session.id, usedSourceRefs: selected.map(entry => entry.sourceRef) },
        });
    }

    try {
        await child.persist({ force: true });
        const content = await runAgentLoop(child.context, subOutput, {
            tools: child.toolRegistry.definitions,
            toolRegistry: child.toolRegistry,
            plugins: child.plugins,
            persist: () => child.persist(),
            client: model,
            audit: child.auditWriter,
        });
        const clipped = clipResult(content);
        const result = {
            status: 'completed',
            content: clipped.content,
            contentTruncated: clipped.truncated,
            childSessionId: child.session.id,
            childTraceId,
            auditRef: { sessionId: child.session.id, traceId: childTraceId },
            usedSourceRefs: selected.map(entry => entry.sourceRef),
            producedArtifacts: [],
            error: null,
        };
        if (context.auditWriter) {
            context.auditWriter.record({
                eventType: 'subagent.completed',
                actor: args.agent,
                spanId: childTraceId,
                parentSpanId: context.auditWriter.activeTraceId,
                content: clipped.content,
                payload: result,
            });
        }
        return result;
    } catch (error) {
        const result = {
            status: 'failed',
            content: '',
            childSessionId: child.session.id,
            childTraceId,
            auditRef: { sessionId: child.session.id, traceId: childTraceId },
            usedSourceRefs: selected.map(entry => entry.sourceRef),
            producedArtifacts: [],
            error: error.message,
        };
        if (context.auditWriter) {
            context.auditWriter.record({
                eventType: 'subagent.failed',
                actor: args.agent,
                spanId: childTraceId,
                parentSpanId: context.auditWriter.activeTraceId,
                payload: result,
            });
        }
        return result;
    } finally {
        await child.persist({ force: true, closing: true }).catch(() => {});
        await child.dispose('subagent-complete');
    }
}

module.exports = {
    definition,
    handler,
    prompt,
    capabilities,
    effects: 'external',
    FORWARDED_CAPABILITIES,
    createSubagentCapabilities,
    selectedContext,
    clipResult,
};
