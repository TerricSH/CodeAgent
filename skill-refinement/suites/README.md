# Skill Refinement suites

Create one directory per suite containing `suite.json` and a seed Skill. Suite directories are
runtime inputs and are ignored by Git; copy `suite.template.json` to start a schema-version 2 suite.
The loader is strict: unknown fields and legacy fixed-task/fixed-step fields are rejected.

## Dataset contract

Every suite provides three non-empty, disjoint sets. Item IDs must be unique across all splits.

```json
{
  "dataset": {
    "train": [{"id":"train-001","task":"..."}],
    "selection": [{"id":"selection-001","task":"..."}],
    "test": [{"id":"test-001","task":"..."}]
  }
}
```

Each split may instead be `{"file":"train.jsonl"}` or point to a JSON file containing an array
or `{"items": [...]}`. Paths are relative to the suite directory and cannot escape it. An item may
contain `metadata` and may override `evaluation`; metadata is recorded for the harness but is not
inserted into the task prompt.

`train` is the only source of reflection evidence. `selection` is used only for baseline and
candidate gates. `test` runs once, after optimization, on the best validation-gated Skill. The
complete suite directory is excluded from rollout snapshots to keep held-out items private.

## Automated reward contract

The harness must return one scalar reward in `[0,1]`. The reflection model never scores its own
edits. With the default `exit_code` mode, exit code zero maps to `1` and all task failures map to
`0`. Protected-path violations map to `0`; infrastructure failures have no reward and invalidate the
batch.

For partial rewards, configure JSON output:

```json
{
  "evaluation": {
    "command": "node evaluate.js",
    "reward": {
      "mode": "stdout_json",
      "field": "reward",
      "successField": "success",
      "successThreshold": 1
    }
  }
}
```

The evaluator may log normally but its last non-empty stdout line must be JSON, for example
`{"reward":0.75,"success":false}`. Candidate selection and final test scores are unweighted means
over their fixed splits.

## Optimizer settings

Paper-aligned defaults are four epochs, rollout batch size 40, reflection minibatch size 8, merge
batch size 8, 16 analyst workers, three maximum reflection rounds, and an edit budget of 4 decaying
to 2 with a cosine schedule. `accumulationFactor` groups several separately reflected rollout
batches into one update. Epoch steps are derived entirely from the shuffled training set.

The rejected buffer is epoch-local. Slow update compares the same sampled training items under the
previous and current epoch-end Skills, writes only the protected `SLOW_UPDATE` region, and passes
that candidate through the same selection gate. Meta update remains optimizer-only and is never
included in the deployed Skill.

A logical rollout batch may be larger than sandbox concurrency. All tasks in the batch use the same
frozen Skill; the existing sandbox pool executes them in bounded parallel waves and the optimizer
waits for the complete batch before reflecting.

Model references use `vendor[@interface][/model]`. Either model field may be omitted to use the
current session model. Credentials must remain in provider configuration, never in suite files.
