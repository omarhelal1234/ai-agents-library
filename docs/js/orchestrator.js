// Orchestrator: given an idea + the full agent catalog, asks Claude to assemble
// the right team and a phased execution plan. Output is strict JSON.

import { callClaudeJSON, callClaude, callClaudeStream, extractJSON } from "./api.js";
import { buildCatalogForPrompt } from "./agents.js";
import { retryAsync } from "./retry.js";

const PLAN_SYSTEM = `You are the Orchestrator for "The Agency" — a roster of 180+ specialist AI agents organized into divisions. Given a user idea, you decide:

1. Which agents to deploy (3 to 12 — favor a tight team over a giant one).
2. How to phase the work so independent agents run in parallel.
3. What concrete task each agent gets, written in that agent's voice/scope.
4. Whether the project needs a backend database (Supabase project auto-provisioned).
5. A concise tech stack and project name.

OUTPUT RULES — STRICT
You MUST respond with one JSON object, no prose, no fences. Schema:

{
  "projectName": "kebab-case, <= 60 chars",
  "projectTitle": "Short human title",
  "summary": "1-2 sentence pitch",
  "techStack": ["string", ...],     // 3-8 items
  "needsDatabase": true | false,    // true if the project needs Supabase
  "githubPagesReady": true | false, // can the build be served from GitHub Pages?
  "team": [
    {
      "slug": "exact-agent-slug-from-catalog",
      "rationale": "Why this agent (1 sentence)",
      "task": "Specific deliverable this agent owns (2-3 sentences). Include file paths if relevant.",
      "model": "claude" | "openai",
      "phase": 1,                   // integer, 1..N
      "dependsOn": []               // agent slugs whose output is needed first
    }
  ],
  "phases": [
    { "phase": 1, "label": "Short phase name", "agents": ["slug1","slug2"] }
  ],
  "deliveryNotes": "How outputs should bundle into the repo (entry file, build step, deployment notes)."
}

GUIDELINES
- The "slug" MUST match an entry in the catalog exactly. Never invent slugs.
- Prefer parallelism: discovery/design/architecture agents run together in phase 1; build in phase 2; QA/marketing in phase 3.
- For projects that "ship to GitHub Pages", set githubPagesReady=true and include a frontend-developer-style agent.
- Set needsDatabase=true only when the idea actually requires persistent multi-user data. Static sites with optional waitlist signup → true. Calculators, portfolios, landing pages with no signup → false.
- Keep the team focused. Don't include marketing/sales agents unless the idea explicitly involves go-to-market work.`;

export async function planTeam({ apiKey, idea, signal }) {
  const catalog = buildCatalogForPrompt();
  const user = `# User idea
${idea}

# Agent catalog (slug | division | name — description)
${catalog}

Return the orchestration JSON now.`;
  const { parsed, usage } = await callClaudeJSON({
    apiKey,
    system: PLAN_SYSTEM,
    user,
    max_tokens: 4000,
    signal,
  });
  // Light validation
  if (!parsed || !Array.isArray(parsed.team) || parsed.team.length === 0) {
    throw new Error("Orchestrator returned no team");
  }
  if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    // Reconstruct phases from team
    parsed.phases = rebuildPhases(parsed.team);
  }
  parsed.needsDatabase = !!parsed.needsDatabase;
  parsed.githubPagesReady = parsed.githubPagesReady !== false;
  parsed._usage = usage;
  return parsed;
}

function rebuildPhases(team) {
  const byPhase = {};
  for (const m of team) {
    const p = m.phase || 1;
    if (!byPhase[p]) byPhase[p] = [];
    byPhase[p].push(m.slug);
  }
  return Object.entries(byPhase)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([p, agents]) => ({ phase: Number(p), label: `Phase ${p}`, agents }));
}

// ----- Worker prompt builder -----
// Build the user prompt for one worker agent given the plan + outputs of its deps.
export function buildWorkerPrompt({ plan, member, depsOutputs }) {
  const ctxParts = [];
  ctxParts.push(`# Project context
- Project name: ${plan.projectName}
- Title: ${plan.projectTitle}
- Summary: ${plan.summary}
- Tech stack: ${(plan.techStack || []).join(", ") || "(unspecified)"}
- Needs database: ${plan.needsDatabase ? "yes (Supabase will be provisioned)" : "no"}
- Ships to: ${plan.githubPagesReady ? "GitHub Pages (static)" : "TBD"}
- Delivery notes: ${plan.deliveryNotes || ""}`);

  if (depsOutputs && depsOutputs.length) {
    ctxParts.push(`# Upstream agent outputs (use as input)`);
    for (const d of depsOutputs) {
      ctxParts.push(`## From: ${d.slug}\n${truncate(d.output, 4000)}`);
    }
  }

  ctxParts.push(`# Your task
${member.task}`);

  ctxParts.push(`# How to respond
Respond in markdown. When you produce code or config files, ALWAYS use fenced code blocks with a path comment on the first line, like:

\`\`\`html
<!-- file: index.html -->
...
\`\`\`

\`\`\`js
// file: src/app.js
...
\`\`\`

\`\`\`sql
-- file: db/schema.sql
...
\`\`\`

If you produce text deliverables (specs, copy, plans), include them as fenced markdown blocks with a path comment:

\`\`\`md
<!-- file: docs/SPEC.md -->
...
\`\`\`

End with a short "Handoff notes:" paragraph for downstream agents.`);

  return ctxParts.join("\n\n");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + `\n... [truncated, ${s.length - n} chars]` : s;
}

// ----- Integrator -----
// After all workers finish, ask Claude to assemble a clean file tree.
const INTEGRATOR_SYSTEM = `You are the Integrator. You receive the outputs of multiple specialist agents and assemble them into a single, coherent project ready to push to a new GitHub repo.

OUTPUT RULES — STRICT
Respond with one JSON object, no prose, no fences:

{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "README.md", "content": "..." }
  ],
  "summary": "1-2 sentence shipping summary",
  "homepageHint": "filename to feature (e.g. index.html)"
}

REQUIREMENTS
- "files" must be a non-empty array. Every entry has both "path" and "content".
- Always include a thoughtful README.md.
- Always include a .gitignore appropriate for the tech stack.
- If the project ships to GitHub Pages, the entry point MUST be index.html at the repo root (or all static files at root). Do NOT use a /docs subfolder.
- If a Supabase database has been provisioned, include a .env.example with SUPABASE_URL and SUPABASE_ANON_KEY placeholders, and reference them in code.
- If a db schema SQL is provided, include it at db/schema.sql.
- Resolve conflicts between agents in favor of a working, consistent project.
- Keep file content COMPLETE — no "TODO" stubs.
- Total files: aim for 4 to 20, only what's needed.`;

// Resilient integrator:
//   - Wraps the LLM call + JSON parse in retryAsync (handles 5xx + Unbalanced JSON).
//   - Calls `onAttempt` after each attempt with the raw text so the caller can
//     persist it to the state store BEFORE parsing. This means a truncated
//     response is still inspectable / manually recoverable instead of being lost.
//   - Bumps max_tokens on retry to widen the recovery window for the most common
//     failure mode (output truncation).
export async function integrateOutputs({ apiKey, plan, outputs, hasSupabase, signal, onAttempt }) {
  const MAX_AGENT_CHARS = 12000;
  const MAX_TOTAL_CHARS = 90000;
  let used = 0;
  const blocks = outputs.map((o) => {
    const remaining = Math.max(0, MAX_TOTAL_CHARS - used);
    const limit = Math.min(MAX_AGENT_CHARS, remaining);
    const raw = String(o.output || "");
    const content = raw.length > limit
      ? raw.slice(0, limit) + `\n\n[truncated ${raw.length - limit} chars]`
      : raw;
    used += content.length;
    return `## ${o.slug} (${o.name})\n\n${content}`;
  }).join("\n\n---\n\n");
  const user = `# Project
- name: ${plan.projectName}
- title: ${plan.projectTitle}
- summary: ${plan.summary}
- tech: ${(plan.techStack || []).join(", ")}
- needsDatabase: ${plan.needsDatabase}
- githubPagesReady: ${plan.githubPagesReady}
- supabaseProvisioned: ${hasSupabase ? "yes" : "no"}
- deliveryNotes: ${plan.deliveryNotes || ""}

# Agent outputs
${blocks}

Now produce the final file tree JSON.`;

  let lastUsage = null;
  let lastRaw = null;

  const parsed = await retryAsync(
    async (attempt) => {
      // Bump tokens on retry to fight truncation, which is the #1 cause of Unbalanced JSON.
      const max_tokens = attempt === 1 ? 16000 : attempt === 2 ? 24000 : 32000;
      const { text, usage } = await callClaudeStream({
        apiKey,
        system: INTEGRATOR_SYSTEM,
        messages: [{ role: "user", content: user }],
        max_tokens,
        temperature: 0.2,
        signal,
      });
      lastUsage = usage;
      lastRaw = text;
      // Persist raw BEFORE parsing — so we keep it even if extractJSON throws.
      if (onAttempt) {
        try { await onAttempt({ attempt, raw: text, parsed: null, error: null }); } catch {}
      }
      const out = extractJSON(text);
      if (!out || !Array.isArray(out.files) || out.files.length === 0) {
        throw new Error("Integrator returned no files");
      }
      out.files = out.files.filter((f) => typeof f.path === "string" && typeof f.content === "string");
      // Persist parsed on success
      if (onAttempt) {
        try { await onAttempt({ attempt, raw: text, parsed: out, error: null }); } catch {}
      }
      return out;
    },
    {
      retries: 3,
      baseDelayMs: 2000,
      onAttempt: ({ attempt, error, willRetry, nextDelayMs }) => {
        if (error && onAttempt) {
          // Caller already got the raw text on success; on failure persist the error too.
          try { onAttempt({ attempt, raw: lastRaw, parsed: null, error: error.message }); } catch {}
        }
      },
    }
  );

  parsed._usage = lastUsage;
  parsed._raw = lastRaw;
  return parsed;
}
