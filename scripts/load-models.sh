#!/usr/bin/env bash
# Bring the pool up in a state that survives fan-out.
#
# Two LM Studio defaults will break a multi-model pool:
#   - a per-model TTL unloads an idle member, and the reload lands mid-fan-out
#   - a model whose configured context is huge (qwen ships at 262144) needs far
#     more memory to reload than its weights suggest, so the reload is refused
#     by the resource guardrail once the other members are resident
# Loading explicitly with a sane context and no TTL avoids both.
set -euo pipefail

export PATH="$PATH:$HOME/.lmstudio/bin"
CTX="${FUGU_CONTEXT:-65536}"

for model in "qwen/qwen3.8-27b" "google/gemma-4-31b" "meta/muse-glimmer"; do
  echo "==> $model (context $CTX, no TTL)"
  lms load "$model" --context-length "$CTX" --gpu max -y
done

# Only needed if the ollama-hosted member is re-enabled in config.json.
if [ "${FUGU_OLLAMA:-0}" = "1" ] && ! curl -sf --max-time 2 http://localhost:11434/v1/models >/dev/null; then
  echo "==> starting ollama"
  nohup ollama serve >/tmp/ollama.log 2>&1 &
  sleep 3
fi

lms ps
