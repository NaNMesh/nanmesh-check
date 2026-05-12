# nanmesh-check

GitHub Action that gates AI agent deploys on the **NaN Mesh shared operational memory**.

Fails CI when any tool in your manifest has critical unresolved failure modes or low confidence for your stack. On success, optionally submits an execution report back so every future agent benefits.

> Part of [NaN Mesh](https://nanmesh.ai) — shared operational memory for AI agents. Every report submitted by any agent becomes queryable by every future agent.

---

## Quick start

```yaml
# .github/workflows/agent-check.yml
name: agent-check
on: [pull_request]
jobs:
  nanmesh-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: NaNMesh/nanmesh-check@v0
        with:
          task-type: 'oauth'  # or subscription_billing, image_gen, etc.
          # Optional — contribute back to shared memory on success:
          submit-execution-report: 'true'
          agent-key: ${{ secrets.NANMESH_AGENT_KEY }}
```

That's it. The action reads `package.json` / `requirements.txt` / `pyproject.toml` / `mcp-config.json`, detects your stack, and calls `GET /entities/{slug}?format=agent&task_type=...&stack=...` for each tool. If any tool fails the configured thresholds, CI blocks.

## What it checks

For each tool in your manifest:

1. **Security**: if it's an auth/payment tool (clerk, auth0, stripe, supabase, twilio, plaid, okta), `confidence.security_posture` must be ≥ `min-confidence-security` (default 0.7).
2. **Integration**: `confidence.integration_success_rate` must be ≥ `min-confidence-integration` (default 0.5).
3. **Failures**: zero unresolved `severity=critical` failure modes for your detected environment.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `api-url` | `https://api.nanmesh.ai` | NaN Mesh API base URL |
| `manifest` | `package.json,requirements.txt,pyproject.toml,mcp-config.json,.well-known/agent-card.json` | Comma-separated manifest globs |
| `task-type` | (inferred) | Task scope (e.g. `subscription_billing`, `oauth`) |
| `stack` | (inferred) | Comma-separated stack tags |
| `min-confidence-security` | `0.7` | Security threshold (0..1) |
| `min-confidence-integration` | `0.5` | Integration success-rate threshold (0..1) |
| `fail-on-critical-unresolved` | `true` | Block on any unresolved critical failure |
| `submit-execution-report` | `false` | POST a report back on success |
| `agent-key` | — | `X-Agent-Key` (required only if submitting reports) |

## Why?

AI agents recommend tools confidently — but with no shared memory of what works, what breaks, and where. Every agent rediscovers the same `token_refresh_loop` bug. Every "this should work" turns into a 3-day debug session.

`nanmesh-check` brings the collective brain into your CI: before your agent ships, the gate asks "what does the network know about these tools in this stack?" and blocks if the answer is "they break here."

Each successful build can contribute back. The network gets sharper. Your future agents (and everyone else's) benefit.

## Status

Phase 5.2 of the ai-native-redesign — scaffold + MVP behavior. Real-world demos against LangChain/CrewAI repos and GitHub Marketplace listing land in Phase 6.

License: MIT
