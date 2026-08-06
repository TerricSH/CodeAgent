import argparse
import json
import os
import sys


parser = argparse.ArgumentParser()
parser.add_argument("--embedding-model")
parser.add_argument("--rerank-model")
parser.add_argument("--device")
parser.add_argument("--batch-size")
parser.parse_args()


def dispatch(request):
    operation = request.get("operation")
    if operation == "info":
        return {
            "offline": os.environ.get("HF_HUB_OFFLINE") == "1"
            and os.environ.get("TRANSFORMERS_OFFLINE") == "1",
            "telemetryDisabled": os.environ.get("HF_HUB_DISABLE_TELEMETRY") == "1"
            and os.environ.get("DO_NOT_TRACK") == "1",
            "proxiesRemoved": not any(
                os.environ.get(name)
                for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")
            ),
            "utf8": os.environ.get("PYTHONUTF8") == "1"
            and os.environ.get("PYTHONIOENCODING") == "utf-8",
        }
    if operation == "embed":
        return [[len(str(value)), 1] for value in request.get("inputs") or []]
    if operation == "rerank":
        documents = request.get("documents") or []
        top_n = int(request.get("topN") or len(documents))
        return [
            {"index": index, "score": index}
            for index in reversed(range(len(documents)))
        ][:top_n]
    raise ValueError("unsupported operation")


for raw_line in sys.stdin:
    request = json.loads(raw_line)
    try:
        response = {"id": request.get("id"), "result": dispatch(request)}
    except Exception as error:
        response = {"id": request.get("id"), "error": {"message": str(error)}}
    print(json.dumps(response), flush=True)
