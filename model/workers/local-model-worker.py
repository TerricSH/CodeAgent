import argparse
import inspect
import json
import logging
import os
import sys
import traceback


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--rerank-model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=32)
    return parser.parse_args()


args = parse_args()
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")

for label, model_path in (
    ("embedding", args.embedding_model),
    ("rerank", args.rerank_model),
):
    if not os.path.isabs(model_path) or not os.path.isdir(model_path):
        raise ValueError(f"Local {label} model must be an existing absolute directory: {model_path}")

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

try:
    import torch
    from sentence_transformers import CrossEncoder, SentenceTransformer
except Exception as error:
    print(
        "Local RAG requires sentence-transformers and torch: " + str(error),
        file=sys.stderr,
        flush=True,
    )
    raise


embedding_options = {"device": args.device}
if "local_files_only" in inspect.signature(SentenceTransformer.__init__).parameters:
    embedding_options["local_files_only"] = True
embedding_model = SentenceTransformer(args.embedding_model, **embedding_options)

rerank_options = {"device": args.device}
if "local_files_only" in inspect.signature(CrossEncoder.__init__).parameters:
    rerank_options["local_files_only"] = True
else:
    rerank_options["tokenizer_args"] = {"local_files_only": True}
    rerank_options["automodel_args"] = {"local_files_only": True}
rerank_model = CrossEncoder(args.rerank_model, **rerank_options)
rerank_model.model.eval()


def rerank_scores(query, documents):
    scores = []
    for start in range(0, len(documents), args.batch_size):
        batch = documents[start:start + args.batch_size]
        encoded = rerank_model.tokenizer(
            [query] * len(batch),
            batch,
            padding=True,
            truncation=True,
            max_length=rerank_model.max_length,
            return_tensors="pt",
        )
        encoded = {
            name: value.to(rerank_model.model.device)
            for name, value in encoded.items()
        }
        with torch.no_grad():
            logits = rerank_model.model(**encoded, return_dict=True).logits
        if logits.ndim != 2 or logits.shape[1] != 1:
            raise ValueError(
                "Local rerank model must return exactly one relevance logit per document"
            )
        scores.extend(logits[:, 0].detach().float().cpu().tolist())
    return scores


def dispatch(request):
    operation = request.get("operation")
    if operation == "info":
        return {
            "embeddingDimensions": embedding_model.get_sentence_embedding_dimension(),
            "device": args.device,
            "offline": os.environ.get("HF_HUB_OFFLINE") == "1"
            and os.environ.get("TRANSFORMERS_OFFLINE") == "1"
            and os.environ.get("HF_DATASETS_OFFLINE") == "1",
            "telemetryDisabled": os.environ.get("HF_HUB_DISABLE_TELEMETRY") == "1"
            and os.environ.get("DO_NOT_TRACK") == "1",
        }
    if operation == "embed":
        inputs = request.get("inputs") or []
        if not isinstance(inputs, list):
            raise ValueError("embed inputs must be a list")
        vectors = embedding_model.encode(
            [str(value) for value in inputs],
            batch_size=args.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return vectors.tolist()
    if operation == "rerank":
        query = str(request.get("query") or "")
        documents = request.get("documents") or []
        if not isinstance(documents, list):
            raise ValueError("rerank documents must be a list")
        if not documents:
            return []
        documents = [str(document) for document in documents]
        top_n = max(1, min(int(request.get("topN") or len(documents)), len(documents)))
        flat_scores = rerank_scores(query, documents)
        ranked = sorted(
            ({"index": index, "score": float(score)} for index, score in enumerate(flat_scores)),
            key=lambda item: item["score"],
            reverse=True,
        )
        return ranked[:top_n]
    raise ValueError("unsupported operation: " + str(operation))


for raw_line in sys.stdin:
    request = json.loads(raw_line)
    try:
        result = dispatch(request)
        response = {"id": request.get("id"), "result": result}
    except Exception as error:
        response = {
            "id": request.get("id"),
            "error": {
                "message": str(error),
                "traceback": traceback.format_exc(),
            },
        }
    print(json.dumps(response, ensure_ascii=False), flush=True)
