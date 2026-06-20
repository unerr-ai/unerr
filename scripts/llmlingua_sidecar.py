#!/usr/bin/env python3
"""LLMLingua-2 sidecar for the Lever B content pipeline.

Reads a JSON array of {id, raw} on stdin, compresses each `raw` with
LLMLingua-2, and writes a JSON object {id: {compressed, ratio}} to stdout.

This runs ONLY at dev/build time (`pnpm content:compress`). Production ships the
committed `src/content/compressed.json`, so the CLI never needs Python at
runtime. If llmlingua is not installed this script exits non-zero and the Node
build step falls back to passthrough — the committed artifact stays valid (raw),
just uncompressed.
"""
import json
import sys


def main() -> int:
    try:
        from llmlingua import PromptCompressor
    except Exception as exc:  # noqa: BLE001 — any import failure → passthrough
        sys.stderr.write(f"llmlingua unavailable: {exc}\n")
        return 3

    items = json.load(sys.stdin)
    # LLMLingua-2 — the token-classification model, smaller + faster than the
    # GPT2 perplexity model and the variant the §11.3 plan names.
    compressor = PromptCompressor(
        model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
        use_llmlingua2=True,
    )

    out = {}
    for item in items:
        cid = item["id"]
        raw = item["raw"]
        result = compressor.compress_prompt(raw, rate=0.5, force_tokens=["\n"])
        compressed = result["compressed_prompt"]
        ratio = (len(compressed) / len(raw)) if raw else 1.0
        out[cid] = {"compressed": compressed, "ratio": round(ratio, 4)}

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
