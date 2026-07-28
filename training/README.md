# Reinforcement-learning integration

CodeAgent is the rollout and environment layer. Model optimization remains a separate process so
the Node.js runtime does not own GPU memory, gradients, checkpoints, or distributed workers.

## Adapter contracts

Training integration is capability-based. Registering a model does not imply it is trainable.
Every adapter explicitly declares its capabilities and implements the corresponding methods:

```js
const { defineModelAdapter } = require('./training');

const model = defineModelAdapter({
    id: 'example-code-model',
    capabilities: {
        generate: true,
        multipleSamples: true,
        tokenize: true,
        tokenLogprobs: true,
        referencePolicy: true,
        valueModel: false,
        trainable: true,
        checkpoint: true
    },
    generate: async (request) => worker.generate(request),
    tokenize: async (request) => worker.tokenize(request),
    computeLogprobs: async (batch) => worker.computeLogprobs(batch),
    computeReferenceLogprobs: async (batch) => worker.computeReferenceLogprobs(batch),
    trainStep: async (batch) => worker.trainStep(batch),
    saveCheckpoint: async (request) => worker.saveCheckpoint(request),
    loadCheckpoint: async (request) => worker.loadCheckpoint(request)
});
```

Enabled capabilities are enforced. For example, declaring `tokenLogprobs: true` without
`computeLogprobs()` fails during registration.

Algorithms declare what they need:

```js
const { defineAlgorithmAdapter } = require('./training');

const algorithm = defineAlgorithmAdapter({
    id: 'example-grpo',
    requirements: [
        'generate',
        'multipleSamples',
        'tokenize',
        'tokenLogprobs',
        'referencePolicy',
        'trainable',
        'checkpoint'
    ],
    prepareBatch(batch, { model, config }) {
        return convertTrajectoriesForWorker(batch, config);
    },
    async train(batch, { model }) {
        return await model.trainStep(batch);
    }
});
```

The registry performs capability negotiation before any GPU work starts:

```js
const { TrainingRegistry } = require('./training');

const registry = new TrainingRegistry({
    models: [model],
    algorithms: [algorithm]
});

const compatibility = registry.compatibility('example-code-model', 'example-grpo');
const binding = registry.bind('example-code-model', 'example-grpo', { groupSize: 8 });
const result = await binding.train(trajectories);
```

For a Python/CUDA process, `createWorkerModelAdapter()` maps all enabled methods onto one transport:

```js
const model = createWorkerModelAdapter({
    id: 'worker-model',
    capabilities: { generate: true, tokenize: true, trainable: true },
    worker: {
        request(operation, payload) {
            return rpc.call(operation, payload);
        }
    }
});
```

The transport itself may be HTTP, gRPC, a child process, or a job queue. It is intentionally not
owned by the core training registry.

## Data flow

1. A user or batch driver submits a task.
2. `trajectory-recorder` starts a trajectory before the model turn.
3. The agent performs work with ordinary tools or `docker-sandbox__sandbox_exec`.
4. A sandbox command explicitly marked with `purpose: "evaluation"` produces a deterministic reward.
5. `reward-evaluator` attaches the reward signal to the active trajectory.
6. `trajectory-recorder__trajectory_export` writes finalized trajectories to
   `.code/rl/trajectories/<session-id>.jsonl`.
7. An external Python trainer consumes the JSONL and publishes a new model checkpoint through an
   existing or new model provider.

## JSONL record

Each line is one finalized trajectory:

```json
{
  "id": "uuid",
  "sessionId": "uuid",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "input": {
    "index": 0,
    "content": "task",
    "createdAt": "ISO-8601"
  },
  "toolCalls": [
    {
      "id": "call-id",
      "name": "docker-sandbox__sandbox_exec",
      "arguments": {
        "command": "npm test",
        "purpose": "evaluation"
      },
      "result": "{\"ok\":true,\"exitCode\":0}",
      "recordedAt": "ISO-8601"
    }
  ],
  "rewards": [
    {
      "value": 1,
      "source": "docker-sandbox",
      "reason": "evaluation_passed",
      "metadata": {
        "toolCallId": "call-id",
        "exitCode": 0
      }
    }
  ],
  "reward": 1,
  "finalReply": "done"
}
```

Only deterministic verification commands should use `purpose: "evaluation"`. Exploratory commands
must use `purpose: "work"` so they do not corrupt the reward signal.

## Training boundary

The current model interface exposes inference only. Online policy optimization additionally needs
token log-probabilities, controlled sampling, checkpoint identifiers, a reference policy, and a
trainer that owns gradients. Add those through a dedicated trainable-model adapter or external
worker protocol; do not add backpropagation to `agent-runner.js`.
