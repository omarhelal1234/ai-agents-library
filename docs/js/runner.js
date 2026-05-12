// Phase-based parallel worker runner.
// Walks plan.phases in order, runs all agents in a phase concurrently,
// feeds upstream outputs into downstream prompts, and emits status events.

import { runWorker, pickModel } from "./api.js";
import { fetchPersona, stripFrontmatter, getAgentBySlug } from "./agents.js";
import { buildWorkerPrompt } from "./orchestrator.js";

export function createRunner({ plan, keys, agentsRepo, onEvent, signal }) {
  const outputs = new Map(); // slug -> { slug, name, output, usage, model }
  const statuses = new Map(); // slug -> "queued"|"running"|"done"|"failed"

  for (const m of plan.team) statuses.set(m.slug, "queued");

  const emit = (type, payload) => onEvent && onEvent({ type, ...payload });

  async function runOne(member) {
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

      const { text, usage } = await runWorker({
        provider,
        anthropicKey: keys.anthropic,
        openaiKey: keys.openai,
        system,
        user,
        signal,
      });

      const record = {
        slug: member.slug,
        name: agent?.name || member.slug,
        division: div,
        provider,
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
      return record;
    } catch (err) {
      statuses.set(member.slug, "failed");
      emit("status", { slug: member.slug, status: "failed", error: err.message });
      emit("log", { level: "err", msg: `✗ ${agent?.name || member.slug} failed: ${err.message}` });
      // Don't throw — let other agents continue
      return null;
    }
  }

  async function run() {
    for (const phase of plan.phases) {
      emit("phase", { phase: phase.phase, label: phase.label, agents: phase.agents });
      emit("log", { level: "step", msg: `── Phase ${phase.phase}: ${phase.label} (${phase.agents.length} agents) ──` });

      // Run all agents in this phase in parallel
      const members = phase.agents
        .map((slug) => plan.team.find((m) => m.slug === slug))
        .filter(Boolean);
      await Promise.all(members.map(runOne));

      if (signal?.aborted) {
        emit("log", { level: "warn", msg: "Run aborted." });
        throw new Error("aborted");
      }
    }
    return Array.from(outputs.values());
  }

  return { run, outputs, statuses };
}
