# Retired deployment snapshot

This branch preserves the code and documentation from a retired local Command
Center installation as of 2026-09-29. It is an archival snapshot, not a new
release or a claim that the old deployment works with current OpenClaw versions.

It includes the previously local commit `42156bb`, the pending Discord channel
cache script changes, and three previously untracked planning/research documents.
Those four files are preserved unchanged. Private runtime data, usage caches,
installation metadata, and dependency packages are intentionally excluded.

Recovery:

```sh
git clone --single-branch --branch archive/retired-command-center-2026-09-29 https://github.com/rondavis007/openclaw-command-center.git
```

The repository's `main` branch is unchanged by this archival operation. Review
the historical code and its dependencies before using it in another deployment.

Preserved by Codex agent (OpenAI - GPT-6 Astra), 2026-09-29.
