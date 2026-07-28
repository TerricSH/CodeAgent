import json
import sys


def dispatch(request):
    operation = request["operation"]
    payload = request.get("payload") or {}
    if operation == "train_step":
        batch = payload.get("batch") or {}
        trajectories = batch.get("trajectories") or []
        return {
            "algorithmId": payload.get("algorithmId"),
            "trajectoryCount": len(trajectories),
            "loss": 0.125,
            "checkpoint": "checkpoints/test-step",
        }
    if operation == "generate":
        return {"samples": [{"content": "python-worker-answer"}]}
    if operation in {
        "tokenize",
        "compute_logprobs",
        "compute_reference_logprobs",
        "compute_values",
        "save_checkpoint",
        "load_checkpoint",
    }:
        return {"ok": True}
    raise ValueError(f"unsupported operation: {operation}")


for raw_line in sys.stdin:
    request = json.loads(raw_line)
    try:
        result = dispatch(request)
        response = {"id": request["id"], "result": result}
    except Exception as error:
        response = {"id": request.get("id"), "error": {"message": str(error)}}
    print(json.dumps(response), flush=True)
