// Phase-based parallel worker runner.
// Walks plan.phases in order, runs all agents in a phase concurrently,
// feeds upstream outputs into downstream prompts, and emits status events.
//
// Resilience features:
//   - Per-agent retry with exponential backoff (transient 5xx / rate limit / network).
//   - Skips agents whose output is already in `priorOutputs` (resume / CR support).
//   - Persists each agent's outcome via the onAgentDone callback (the caller
//     uses this to write to the Supabase state store).

import { runWorker, pickModel } from "./api.js";
import { fetchPersona, stripFrontmatter, getAgentBySlug } from "./agents.js";
import { buildWorkerPrompt } from "./orchestrator.js";
import { retryAsync } from "./retry.js";

export function createRunner({
  plan,
  keys,
  agentsRepo,
  onEvent,
  signal,
  priorOutputs,        // Map<slug, record> — outputs to reuse without rerunning
  onAgentDone,         // async (record) => void — persistence hook
  forceRerunSlugs,     // Set<slug> — agents to force-rerun even if priorOutputs has them
}) {
  const outputs = new Map();
  const statuses = new Map();
  const force = forceRerunSlugs || new Set();

  // Pre-populate from prior outputs (resume path)
  if (priorOutputs && priorOutputs.size > 0) {
    for (const [slug, rec] of priorOutputs) {
      if (force.has(slug)) continue;          // re-run requested
      if (!rec || rec.status !== "done") continue;
      outputs.set(slug, rec);
      statuses.set(slug, "done");
    }
  }
  // Anyone not preloaded starts as queued
  for (const m of plan.team) {
    if (!statuses.has(m.slug)) statuses.set(m.slug, "queued");
  }

  const emit = (type, payload) => onEvent && onEvent({ type, ...payload });

  async function runOne(member) {
    // Skip if already done and not flagged for force-rerun
    if (statuses.get(member.slug) === "done" && !force.has(member.slug)) {
      const rec = outputs.get(member.slug);
      emit("status", { slug: member.slug, status: "done", skipped: true });
      emit("log", { level: "info", msg: `↷ ${rec?.name || member.slug} — already complete, skipping` });
      return rec;
    }

    statuses.set(member.slug, "running");
    emit("status", { slug: member.slug, status: "running" });

    const agent = getAgentBySlug(member.slug);
    const div = agent?.division || "Specialized";
    const provider = pickModel({
      requested: member.model,
      division: div,
      hasOpenAI: !!keys.openai,
    });

    try {
      const personaMd = await fetchPersona(member.slug, agentsRepo);
      const system = stripFrontmatter(personaMd);
      const depsOutputs = (member.dependsOn || [])
        .map((s) => outputs.get(s))
        .filter(Boolean);
      const user = buildWorkerPrompt({ plan, member, depsOutputs });

      emit("log", { level: "info", msg: `▶ ${agent?.name || member.slug} (${div}) — ${provider} starting…` });

      const { text, usage } = await retryAsync(
        () => runWorker({
          provider,
          anthropicKey: keys.anthropic,
          openaiKey: keys.openai,
          system,
          user,
          signal,
        }),
        {
          retries: 3,
          baseDelayMs: 1500,
          onAttempt: ({ attempt, error, willRetry, nextDelayMs }) => {
            if (error && willRetry) {
              emit("log", {
                level: "warn",
                msg: `⟳ ${agent?.name || member.slug} attempt ${attempt} failed (${error.message.slice(0, 120)}) — retrying in ${Math.round(nextDelayMs/1000)}s`,
              });
            }
          },
        }
      );

      const record = {
        slug: member.slug,
        name: agent?.name || member.slug,
        division: div,
        provider,
        phase: member.phase || 1,
        status: "done",
        output: text,
        usage,
      };
      outputs.set(member.slug, record);
      statuses.set(member.slug, "done");
      emit("status", { slug: member.slug, status: "done", provider, usage });
      emit("log", {
        level: "ok",
        msg: `✓ ${agent?.name || member.slug} done (${(text || "").length.toLocaleString()} chars` +
             (usage ? `, in=${usage.input_tokens ?? usage.prompt_tokens ?? "?"}, out=${usage.output_tokens ?? usage.completion_tokens ?? "?"}` : "") + ")",
      });
      if (onAgentDone) {
        try { await onAgentDone(record); } catch (e) { console.warn("onAgentDone failed:", e); }
      }
      return record;
    } catch (err) {
      const failRecord = {
        slug: member.slug,
        name: agent?.name || member.slug,
        division: div,
        provider,
        phase: member.phase || 1,
        status: "failed",
        error: err.message,
      };
      statuses.set(member.slug, "failed");
      emit("status", { slug: member.slug, status: "failed", error: err.message });
      emit("log", { level: "err", msg: `✗ ${agent?.name || member.slug} failed: ${err.message}` });
      if (onAgentDone) {
        try { await onAgentDone(failRecord); } catch {}
      }
      return null;
    }
  }

  async function run() {
    for (const phase of plan.phases) {
      emit("phase", { phase: phase.phase, label: phase.label, agents: phase.agents });
      emit("log", { level: "step", msg: `── Phase ${phase.phase}: ${phase.label} (${phase.agents.length} agents) ──` });

      const members = phase.agents
        .map((slug) => plan.team.find((m) => m.slug === slug))
        .filter(Boolean);
      await Promise.all(members.map(runOne));

      if (signal?.aborted) {
        emit("log", { level: "warn", msg: "Run aborted." });
        throw new Error("aborted");
      }
    }
    return Array.from(outputs.values()).filter((r) => r && r.status === "done");
  }

  return { run, outputs, statuses };
}
