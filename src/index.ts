/**
 * nanmesh-check — GitHub Action that gates AI agent deploys on the NaN Mesh
 * shared operational memory.
 *
 * Flow:
 *   1. Detect manifests (package.json, requirements.txt, pyproject.toml, mcp-config.json, agent-card.json).
 *   2. Extract tool names (deps) + infer stack tags from frameworks present.
 *   3. For each tool, call `GET /entities/{slug}?format=agent&task_type=X&stack=Y` against the
 *      NaN Mesh API and inspect:
 *         - confidence.security_posture vs min-confidence-security
 *         - confidence.integration_success_rate vs min-confidence-integration
 *         - known_failure_modes for unresolved severity=critical entries
 *   4. Fail the build with a clear summary when thresholds are violated.
 *   5. On success, optionally POST an execution_report back to /review with
 *      source_hint='github_action'.
 *
 * Phase 5.2 ships the scaffold. Phase 6.1 wires real-repo demos against
 * 3 LangChain/CrewAI projects.
 */

import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────

type ConfidenceDecomposition = {
  api_stability: number | null;
  documentation_quality: number | null;
  integration_success_rate: number | null;
  cost_efficiency: number | null;
  security_posture: number | null;
  sample_size: number;
  evidence_state: "sufficient" | "insufficient" | "synthesized_only";
};

type FailureMode = {
  failure_type: string;
  severity: "low" | "medium" | "high" | "critical";
  environment_signature: Record<string, unknown>;
  resolved: boolean;
  workaround?: Record<string, unknown> | null;
};

type AgentPayload = {
  slug?: string;
  name?: string;
  confidence_decomposition: ConfidenceDecomposition | null;
  known_failure_modes: FailureMode[];
  network_evidence?: { total_reports?: number };
  schema_version?: string;
};

function readManifests(globs: string[]): { tools: Set<string>; stack: Set<string> } {
  const tools = new Set<string>();
  const stack = new Set<string>();
  const cwd = process.cwd();
  for (const filename of globs) {
    const fp = path.join(cwd, filename.trim());
    if (!fs.existsSync(fp)) continue;
    const text = fs.readFileSync(fp, "utf-8");
    if (filename.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(text);
        for (const k of Object.keys(pkg.dependencies || {})) {
          tools.add(k);
          if (k === "next") stack.add("nextjs");
          if (k.startsWith("@supabase/")) stack.add("supabase");
          if (k.startsWith("@clerk/")) stack.add("clerk");
          if (k === "express" || k === "fastify") stack.add("node-server");
        }
        for (const k of Object.keys(pkg.devDependencies || {})) tools.add(k);
      } catch { /* ignore */ }
    } else if (filename.endsWith("requirements.txt")) {
      for (const line of text.split("\n")) {
        const m = line.trim().match(/^([a-zA-Z0-9_.-]+)/);
        if (m) tools.add(m[1]);
        if (m && m[1].toLowerCase().includes("langchain")) stack.add("langchain");
        if (m && m[1].toLowerCase().includes("crewai")) stack.add("crewai");
        if (m && m[1].toLowerCase() === "fastapi") stack.add("fastapi");
      }
    } else if (filename.endsWith("pyproject.toml")) {
      // Very lightweight extraction — full TOML parser deferred to Phase 6.1
      for (const m of text.matchAll(/"([a-zA-Z0-9_.-]+)\s*(>=|==|<|>|\^)?/g)) {
        tools.add(m[1]);
      }
    } else if (filename.endsWith("mcp-config.json") || filename.endsWith("agent-card.json")) {
      try {
        const cfg = JSON.parse(text);
        for (const tool of cfg.tools || []) {
          if (typeof tool === "string") tools.add(tool);
          else if (tool?.name) tools.add(tool.name);
        }
      } catch { /* ignore */ }
    }
  }
  return { tools, stack };
}

// Map a raw dependency name to a NaN Mesh entity slug.
// Phase 5.2 minimal mapping; Phase 6.1 grows the table from real usage.
const SLUG_MAP: Record<string, string> = {
  "@clerk/nextjs": "clerk",
  "@clerk/clerk-sdk-node": "clerk",
  "@supabase/supabase-js": "supabase",
  "@supabase/auth-helpers-nextjs": "supabase",
  "stripe": "stripe",
  "next": "nextjs",
  "auth0": "auth0",
  "@auth0/auth0-react": "auth0",
  "@auth0/nextjs-auth0": "auth0",
  "openai": "openai",
  "anthropic": "anthropic",
  "@anthropic-ai/sdk": "anthropic",
  "langchain": "langchain",
  "@langchain/core": "langchain",
  "crewai": "crewai",
  "resend": "resend",
  "@vercel/blob": "vercel",
  "twilio": "twilio",
  "plaid": "plaid",
};

function toSlug(rawName: string): string | null {
  if (SLUG_MAP[rawName]) return SLUG_MAP[rawName];
  // Fallback: take the part after the last slash, lowercased
  const tail = rawName.split("/").pop()?.toLowerCase();
  return tail || null;
}

const SECURITY_LIKE = new Set(["clerk", "auth0", "stripe", "supabase", "twilio", "plaid", "okta"]);

// ── Main ───────────────────────────────────────────────────────────────────

async function fetchAgentPayload(
  apiUrl: string,
  slug: string,
  taskType: string | undefined,
  stack: string[],
): Promise<AgentPayload | null> {
  const params = new URLSearchParams({ format: "agent" });
  if (taskType) params.set("task_type", taskType);
  if (stack.length) params.set("stack", stack.join(","));
  try {
    const res = await fetch(`${apiUrl}/entities/${encodeURIComponent(slug)}?${params}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json() as AgentPayload;
  } catch {
    return null;
  }
}

async function submitExecutionReport(
  apiUrl: string,
  agentKey: string,
  agentId: string,
  entityId: string,
  taskType: string,
  stack: string[],
): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Key": agentKey },
      body: JSON.stringify({
        entity_id: entityId,
        agent_id: agentId,
        positive: true,
        task_type: taskType,
        stack,
        outcome: "success",
        source_hint: "github_action",
        context: "CI gate passed",
        review: `nanmesh-check verified usage in CI for repo ${process.env.GITHUB_REPOSITORY || "unknown"}`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function run() {
  try {
    const apiUrl = core.getInput("api-url") || "https://api.nanmesh.ai";
    const manifests = (core.getInput("manifest") || "").split(",").filter(Boolean);
    const taskTypeInput = core.getInput("task-type") || undefined;
    const stackInput = (core.getInput("stack") || "").split(",").filter(Boolean);
    const minSecurity = parseFloat(core.getInput("min-confidence-security") || "0.7");
    const minIntegration = parseFloat(core.getInput("min-confidence-integration") || "0.5");
    const failOnCritical = (core.getInput("fail-on-critical-unresolved") || "true") === "true";
    const submitReports = (core.getInput("submit-execution-report") || "false") === "true";
    const agentKey = core.getInput("agent-key") || process.env.NANMESH_AGENT_KEY || "";

    core.info(`nanmesh-check: scanning manifests: ${manifests.join(", ")}`);
    const { tools, stack } = readManifests(manifests);
    for (const s of stackInput) stack.add(s);
    core.info(`Detected ${tools.size} tools, stack: [${Array.from(stack).join(", ")}]`);

    const stackArr = Array.from(stack);
    const blockers: string[] = [];
    const reasons: string[] = [];
    type Finding = { slug: string; severity: string; failure_type: string; resolved: boolean };
    const findings: Record<string, { failures: Finding[]; reports_count: number; conf: ConfidenceDecomposition | null }> = {};
    let toolsWithData = 0;

    for (const raw of tools) {
      const slug = toSlug(raw);
      if (!slug) continue;
      const payload = await fetchAgentPayload(apiUrl, slug, taskTypeInput, stackArr);
      if (!payload) continue;
      toolsWithData++;

      const conf = payload.confidence_decomposition;
      const isSecurity = SECURITY_LIKE.has(slug);
      const unresolvedFailures = (payload.known_failure_modes || []).filter(f => !f.resolved);

      // Always collect findings for informational logging — even when not blocking.
      findings[slug] = {
        failures: unresolvedFailures.map(f => ({
          slug,
          severity: f.severity,
          failure_type: f.failure_type,
          resolved: f.resolved,
        })),
        reports_count: payload.network_evidence?.total_reports ?? 0,
        conf: conf ?? null,
      };

      // Blocking checks
      if (isSecurity && conf && conf.security_posture !== null && conf.security_posture < minSecurity) {
        blockers.push(slug);
        reasons.push(`${slug}: security_posture ${conf.security_posture} < threshold ${minSecurity}`);
        continue;
      }
      if (conf && conf.integration_success_rate !== null && conf.integration_success_rate < minIntegration) {
        blockers.push(slug);
        reasons.push(`${slug}: integration_success_rate ${conf.integration_success_rate} < threshold ${minIntegration}`);
        continue;
      }
      if (failOnCritical) {
        const critical = unresolvedFailures.filter(f => f.severity === "critical");
        if (critical.length > 0) {
          blockers.push(slug);
          reasons.push(
            `${slug}: ${critical.length} unresolved critical failure(s) — ` +
            critical.slice(0, 2).map(f => f.failure_type).join(", ")
          );
        }
      }
    }

    core.setOutput("blocked-tools", JSON.stringify(blockers));

    // ── Informational summary: surface what the network knows about each tool. ─────
    // Print sorted by severity so high-impact items appear first.
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const slugsByImpact = Object.keys(findings).sort((a, b) => {
      const worstA = findings[a].failures.length
        ? Math.min(...findings[a].failures.map(f => severityRank[f.severity as keyof typeof severityRank] ?? 4))
        : 99;
      const worstB = findings[b].failures.length
        ? Math.min(...findings[b].failures.map(f => severityRank[f.severity as keyof typeof severityRank] ?? 4))
        : 99;
      return worstA - worstB;
    });

    const summaryLines: string[] = [];
    summaryLines.push("## nanmesh-check findings");
    summaryLines.push(`Scanned **${tools.size}** tools from manifests; **${toolsWithData}** had network data.`);
    summaryLines.push("");
    summaryLines.push("| Tool | Reports | Known unresolved failures | Confidence (sec / integ) |");
    summaryLines.push("|---|---|---|---|");

    for (const slug of slugsByImpact) {
      const f = findings[slug];
      const failures = f.failures.length
        ? f.failures.slice(0, 3).map(x => `\`${x.failure_type}\` (${x.severity})`).join(", ")
        : "none";
      const sec = f.conf?.security_posture ?? "—";
      const integ = f.conf?.integration_success_rate ?? "—";
      summaryLines.push(`| [${slug}](https://nanmesh.ai/entities/${slug}) | ${f.reports_count} | ${failures} | ${sec} / ${integ} |`);
      // Also info-log per-tool finding for the workflow log
      if (f.failures.length > 0) {
        const worst = f.failures.slice().sort(
          (a, b) => (severityRank[a.severity as keyof typeof severityRank] ?? 4)
                  - (severityRank[b.severity as keyof typeof severityRank] ?? 4)
        )[0];
        if (worst.severity === "critical") {
          core.error(`${slug}: ${f.failures.length} unresolved failure(s), worst=critical (${worst.failure_type})`);
        } else if (worst.severity === "high" || worst.severity === "medium") {
          core.warning(
            `${slug}: ${f.failures.length} unresolved failure(s), worst=${worst.severity} (${worst.failure_type}). ` +
            `Not blocking (threshold=critical). See https://nanmesh.ai/entities/${slug}`
          );
        }
      }
    }

    // Write to GitHub Actions step summary for a nice rendering in the UI
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = await import("node:fs/promises");
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n") + "\n");
    }

    if (blockers.length > 0) {
      core.setFailed(
        `nanmesh-check: ${blockers.length} tool(s) blocked deploy:\n  - ` +
        reasons.join("\n  - ") +
        `\n\nSee https://nanmesh.ai/entities/<slug> for each tool's full agent payload.`
      );
      return;
    }

    let submitted = 0;
    if (submitReports && agentKey && taskTypeInput) {
      const agentId = `nanmesh-check/${process.env.GITHUB_REPOSITORY || "unknown"}`;
      for (const raw of tools) {
        const slug = toSlug(raw);
        if (!slug) continue;
        const payload = await fetchAgentPayload(apiUrl, slug, taskTypeInput, stackArr);
        if (!payload?.slug) continue;
        const ok = await submitExecutionReport(apiUrl, agentKey, agentId,
          payload.slug, taskTypeInput, stackArr);
        if (ok) submitted++;
      }
    }
    core.setOutput("reports-submitted", String(submitted));

    const totalWarnings = Object.values(findings).reduce((n, f) => n + f.failures.length, 0);
    core.info(
      `nanmesh-check passed. ${tools.size} tools scanned, ${toolsWithData} with network data, ` +
      `${totalWarnings} known unresolved failures surfaced (not blocking). ` +
      `${submitted} execution_reports submitted.`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    core.setFailed(`nanmesh-check error: ${msg}`);
  }
}

run();
