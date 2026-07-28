# Python model packages

Place each trainable model in its own directory:

```text
training/models/
└── my-code-model/
    ├── manifest.json
    ├── worker.py
    ├── checkpoints/
    │   └── base/
    ├── tokenizer/
    └── chat-template.jinja
```

The framework reads only `manifest.json` during discovery. It starts `worker.py` only when
`training-manager__training_start` is called.
`training-manager__training_list` rescans the directory, so a newly added package does not require
restarting the Agent.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "my-code-model",
  "metadata": {
    "family": "my-model-family",
    "description": "Local trainable code model"
  },
  "artifacts": {
    "checkpoint": "checkpoints/base",
    "tokenizer": "tokenizer",
    "chatTemplate": "chat-template.jinja"
  },
  "worker": {
    "command": "python",
    "entry": "worker.py",
    "args": [],
    "timeoutMs": 3600000,
    "maxLineBytes": 16777216,
    "env": {
      "PYTHONUNBUFFERED": "1"
    }
  },
  "capabilities": {
    "generate": true,
    "multipleSamples": true,
    "tokenize": true,
    "tokenLogprobs": true,
    "referencePolicy": true,
    "valueModel": false,
    "trainable": true,
    "checkpoint": true
  },
  "algorithms": [
    {
      "id": "grpo",
      "displayName": "GRPO",
      "default": true,
      "requirements": [
        "generate",
        "multipleSamples",
        "tokenize",
        "tokenLogprobs",
        "referencePolicy",
        "trainable",
        "checkpoint"
      ],
      "config": {
        "required": ["learningRate", "groupSize"]
      }
    }
  ]
}
```

Artifact and worker entry paths must be relative, remain inside the package, and exist during discovery. A worker
command such as `python` is resolved through `PATH`; a relative executable such as
`.venv/Scripts/python.exe` or `.venv/bin/python` is resolved inside the model package.

## JSONL protocol

The worker receives one JSON object per stdin line:

```json
{
  "id": "request-uuid",
  "operation": "train_step",
  "modelId": "my-code-model",
  "payload": {
    "algorithmId": "grpo",
    "config": {
      "learningRate": 0.00001,
      "groupSize": 8
    },
    "batch": {
      "version": 1,
      "trajectories": [],
      "metadata": {}
    }
  },
  "context": {
    "algorithmId": null,
    "config": null
  }
}
```

It must write exactly one response line:

```json
{"id":"request-uuid","result":{"loss":0.25,"checkpoint":"checkpoints/step-1"}}
```

Errors use:

```json
{"id":"request-uuid","error":{"message":"CUDA out of memory"}}
```

Supported operation names are:

- `generate`
- `tokenize`
- `compute_logprobs`
- `compute_reference_logprobs`
- `compute_values`
- `train_step`
- `save_checkpoint`
- `load_checkpoint`

Only protocol JSON may be written to stdout. Send Python logs to stderr.

## Minimal Python worker

```python
import json
import sys


def dispatch(request):
    operation = request["operation"]
    payload = request.get("payload")

    if operation == "train_step":
        # Load the packaged model lazily, calculate gradients, update weights,
        # and save a checkpoint here.
        return {"loss": 0.0, "checkpoint": "checkpoints/latest"}

    raise ValueError(f"unsupported operation: {operation}")


for line in sys.stdin:
    request = json.loads(line)
    try:
        result = dispatch(request)
        response = {"id": request["id"], "result": result}
    except Exception as error:
        response = {"id": request.get("id"), "error": {"message": str(error)}}
    print(json.dumps(response, ensure_ascii=False), flush=True)
```

The Python worker may use PyTorch, TensorFlow, JAX, or another native training framework. The Node
framework does not import TensorFlow.js and does not calculate gradients.

Framework tools:

- `training-manager__training_list`: list valid packages and manifest errors.
- `training-manager__training_check`: verify model/algorithm capabilities.
- `training-manager__training_start`: start the Python entry and send finalized trajectories.
- `training-manager__training_history`: inspect recent training runs.
