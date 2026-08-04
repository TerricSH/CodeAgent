# Docker sandbox

Use `docker-sandbox__sandbox_exec` for isolated exploratory work in the current session workspace.
Never assume a successful sandbox command modified host project files.

Development training is explicit and suite-driven. First call
`docker-sandbox__sandbox_training_suites`, then call
`docker-sandbox__sandbox_training_start` with one listed suite id. A training run creates multiple
independent project snapshots, launches an agent rollout in each snapshot, runs the suite's
host-defined evaluator, ranks the candidates, and exports scored trajectories for SkillOpt. The
task, protected paths, and evaluation command come from the suite manifest and cannot be replaced
by the rollout agent. Do not use ordinary daily coding conversations as implicit training data.

Network access is disabled by default. A training result remains inside the sandbox artifact root
and never writes a candidate back into the host project.
