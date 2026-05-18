// Streaming LLM client tailored for WhatsApp pacing. Routes to Anthropic
// (Claude) or OpenAI (GPT) per call — `providerForAgent` decides which
// agent in the team runs on which model.
//
// Caller iterates `streamChunks` which yields whole "speakable units"
// (sentence or paragraph). Between units the caller can check the
// interrupt queue, send the unit to the bridge, etc. The wire format is
// identical regardless of provider — both providers feed through the
// same sentence-flush logic.

import Anthropic from "npm:@anthropic-ai/sdk@0.30.1";
import OpenAI from "npm:openai@4.67.3";

export type Provider = "anthropic" | "openai";

const ANTHROPIC_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;

function anthropic(): Anthropic {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  return _anthropic;
}

function openai(): OpenAI {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set");
  if (!_openai) _openai = new OpenAI({ apiKey: OPENAI_KEY });
  return _openai;
}

export type ChatMsg = { role: "user" | "assistant"; content: string };

export type StreamChunk = {
  text: string;        // the speakable unit (sentence/paragraph)
  done: boolean;       // true on the final chunk
  fullText: string;    // running accumulation so far
};

export type StreamOpts = {
  provider: Provider;
  system: string;
  messages: ChatMsg[];
  maxTokens?: number;
  abort?: AbortSignal;
};

// Choose a provider for a given agent. Pure routing — the orchestrator
// calls this when assembling streams so each agent runs on the LLM that
// best fits the work it does in the WhatsApp flow.
//
// Routing rationale:
//   * OpenAI for structured / factual / code / ops agents (engineering,
//     testing, paid-media, sales, support, finance, project-management).
//     GPT-4o follows JSON shapes tightly and is faster/cheaper on these.
//   * Anthropic for synthesis, long-form writing, design taste, strategy
//     (design, marketing, strategy, product, academic, game-development,
//     spatial-computing, specialized). Claude wins on coherent long outputs.
//   * Fixed overrides for two named roles:
//       - product-manager (Sarah, discovery) → OpenAI: emits a JSON
//         fence every turn; OpenAI is more disciplined about shape.
//       - engineering-software-architect (Marcus, integrator) → Anthropic:
//         synthesises the whole team's deliverables into one final spec.
export function providerForAgent(slug: string, division?: string | null): Provider {
  if (slug === "product-manager") return "openai";
  if (slug === "engineering-software-architect") return "anthropic";

  const openaiDivisions = new Set([
    "engineering",
    "testing",
    "paid-media",
    "sales",
    "support",
    "finance",
    "project-management",
  ]);
  if (division && openaiDivisions.has(division)) return "openai";
  return "anthropic";
}

// Yield logical chunks (sentence / paragraph) as the model streams.
// We flush when we see a sentence terminator OR a blank line OR
// buffer > 280 chars.
export async function* streamChunks(opts: StreamOpts): AsyncGenerator<StreamChunk> {
  if (opts.provider === "openai") {
    yield* streamOpenAI(opts);
  } else {
    yield* streamAnthropic(opts);
  }
}

async function* streamAnthropic(opts: StreamOpts): AsyncGenerator<StreamChunk> {
  const stream = anthropic().messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: opts.messages,
  }, { signal: opts.abort });

  let buf = "";
  let acc = "";
  for await (const event of stream) {
    if (event.type !== "content_block_delta") continue;
    const delta = (event.delta as { text?: string }).text;
    if (!delta) continue;
    buf += delta;
    acc += delta;
    while (true) {
      const cut = findFlushPoint(buf);
      if (cut < 0) break;
      const piece = buf.slice(0, cut).trim();
      buf = buf.slice(cut).replace(/^\s+/, "");
      if (piece) yield { text: piece, done: false, fullText: acc };
    }
    if (buf.length > 280) {
      const piece = buf.trim();
      buf = "";
      if (piece) yield { text: piece, done: false, fullText: acc };
    }
  }
  const tail = buf.trim();
  if (tail) yield { text: tail, done: true, fullText: acc };
  else yield { text: "", done: true, fullText: acc };
}

async function* streamOpenAI(opts: StreamOpts): AsyncGenerator<StreamChunk> {
  const stream = await openai().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
    messages: [
      { role: "system", content: opts.system },
      ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  }, { signal: opts.abort });

  let buf = "";
  let acc = "";
  for await (const event of stream) {
    const delta = event.choices?.[0]?.delta?.content;
    if (!delta) continue;
    buf += delta;
    acc += delta;
    while (true) {
      const cut = findFlushPoint(buf);
      if (cut < 0) break;
      const piece = buf.slice(0, cut).trim();
      buf = buf.slice(cut).replace(/^\s+/, "");
      if (piece) yield { text: piece, done: false, fullText: acc };
    }
    if (buf.length > 280) {
      const piece = buf.trim();
      buf = "";
      if (piece) yield { text: piece, done: false, fullText: acc };
    }
  }
  const tail = buf.trim();
  if (tail) yield { text: tail, done: true, fullText: acc };
  else yield { text: "", done: true, fullText: acc };
}

function findFlushPoint(s: string): number {
  // Paragraph break.
  const para = s.indexOf("\n\n");
  if (para >= 0) return para + 2;
  // Sentence-ish: ., !, ? followed by space or newline.
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = s[i + 1];
    if (next === " " || next === "\n") return i + 2;
  }
  return -1;
}

// Non-streaming call when we need a structured response (e.g. team JSON).
export async function oneShot(opts: {
  provider: Provider;
  system: string;
  messages: ChatMsg[];
  maxTokens?: number;
}): Promise<string> {
  if (opts.provider === "openai") {
    const res = await openai().chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: opts.maxTokens ?? 1500,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    return res.choices?.[0]?.message?.content ?? "";
  }
  const res = await anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: opts.messages,
  });
  const block = res.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  return block?.text ?? "";
}
