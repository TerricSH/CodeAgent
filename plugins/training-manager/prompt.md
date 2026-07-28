# Model-package training

Use `training-manager__training_list` to discover locally packaged Python training workers.
Use `training-manager__training_check` before training. Call
`training-manager__training_start` only when the user explicitly asks to train or resume training;
it may consume substantial GPU time and modify checkpoints inside the selected model package.
JavaScript only orchestrates the JSONL protocol. All tensor operations, gradients, optimizers, and
checkpoint writes belong to the packaged Python worker.
