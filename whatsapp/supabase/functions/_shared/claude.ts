// Streaming Claude client tailored for WhatsApp pacing.
//
// Caller iterates `streamChunks` which yields whole "speakable units"
// (sentence or paragraph). Between units the caller can check the
// interrupt queue, send the unit to the bridge, etc.

import Anthropic from "npm:@anthropic-ai/sdk@0.30.1";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";
const API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!_client) _client = new Anthropic({ apiKey: API_KEY });
  return _client;
}

export type ChatMsg = { role: "user" | "assistant"; content: string };

export type StreamChunk = {
  text: string;        // the speakable unit (sentence/paragraph)
  done: boolean;       // true on the final chunk
  fullText: string;    // running accumulation so far
};

export type StreamOpts = {
  system: string;
  messages: ChatMsg[];
  maxTokens?: number;
  abort?: AbortSignal;
};

// Yield logical chunks (sentence / paragraph) as the model streams.
// We flush when we see a sentence terminator OR a blank line OR buffer > 280 chars.
export async function* streamChunks(opts: StreamOpts): AsyncGenerator<StreamChunk> {
  const stream = client().messages.stream({
    model: MODEL,
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
    // Try to flush completed sentences/paragraphs.
    while (true) {
      const cut = findFlushPoint(buf);
      if (cut < 0) break;
      const piece = buf.slice(0, cut).trim();
      buf = buf.slice(cut).replace(/^\s+/, "");
      if (piece) yield { text: piece, done: false, fullText: acc };
    }
    // Safety flush for very long un-terminated runs.
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
  system: string;
  messages: ChatMsg[];
  maxTokens?: number;
}): Promise<string> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: opts.messages,
  });
  const block = res.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
  return block?.text ?? "";
}
