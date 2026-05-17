// Orchestrator: runs one phase chunk for a conversation.
//
// Phases:
//   discovery     — PM converses with the user; on "ready" we save product + team.
//   awaiting_go   — team is named; on user's affirmative, transition to build.
//   build         — run each assigned agent in turn; each posts chat + a .docx artifact.
//   integrate     — synthesize final spec, post as .docx.
//   done          — wrap up; future messages will start a new product.
//
// One invocation does ONE chunk and exits. It self-recurses (via background fetch)
// when more work is queued. Streams sentence-by-sentence to the bridge.
// Between chunks the stream checks for pending interrupts; if found, the stream
// aborts and the next invocation picks up the new state.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  consumePendingInterrupts,
  createProduct,
  getAssignments,
  getConversationById,
  getProductById,
  hasPendingInterrupt,
  loadTranscript,
  recordMessage,
  setAssignments,
  setConversationState,
  storeArtifact,
  updateProduct,
  type Conversation,
} from "../_shared/db.ts";
import { findAgent } from "../_shared/agents.ts";
import { oneShot, streamChunks, type ChatMsg } from "../_shared/claude.ts";
import { agentSystem, integratorSystem, pmSystem } from "../_shared/personas.ts";
import { sendDoc, sendText, setTyping } from "../_shared/bridge.ts";
import { encodeBase64, markdownToDocx } from "../_shared/docx.ts";

const BRIDGE_SECRET = Deno.env.get("BRIDGE_SECRET") ?? "";
const SELF_URL = Deno.env.get("RUN_PHASE_URL") ?? "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (req.headers.get("x-bridge-secret") !== BRIDGE_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: { conversation_id?: string };
  try { body = await req.json(); }
  catch { return new Response("bad json", { status: 400 }); }
  const convId = body.conversation_id;
  if (!convId) return new Response("missing conversation_id", { status: 400 });

  const conv = await getConversationById(convId);
  if (!conv) return new Response("not found", { status: 404 });

  try {
    await runChunk(conv);
  } catch (e) {
    console.error("run-phase error:", e);
    await safeIdle(conv.id);
    await sendText(conv.wa_chat_id, `(orchestrator hit a snag: ${shortErr(e)} — say something to try again)`);
  }
  return new Response("ok", { status: 200 });
});

async function runChunk(conv: Conversation): Promise<void> {
  // Consume any interrupt rows so we don't loop forever on them — the user's
  // message text is already in wa_messages.
  await consumePendingInterrupts(conv.id);

  switch (conv.current_phase) {
    case "discovery": return await phaseDiscovery(conv);
    case "awaiting_go": return await phaseAwaitingGo(conv);
    case "build": return await phaseBuild(conv);
    case "integrate": return await phaseIntegrate(conv);
    case "done": return await phaseDone(conv);
    default:
      await sendText(conv.wa_chat_id, `(unknown phase ${conv.current_phase}, resetting)`);
      await setConversationState(conv.id, {
        status: "idle",
        current_phase: "discovery",
        build_index: 0,
      });
  }
}

// ---------- Discovery ----------

async function phaseDiscovery(conv: Conversation): Promise<void> {
  const system = await pmSystem();
  const messages = await buildClaudeMessages(conv.id);
  const display = { name: "Sarah", role: "PM" };

  const acc = await streamToChat(conv, system, messages, display);
  if (acc === null) return; // interrupted; bail, next invocation will resume

  const decision = parseFinalJson(acc.fullText);
  if (decision?.status === "ready") {
    await onReady(conv, decision);
    return;
  }
  // gathering or unparseable: wait for next user reply.
  await setConversationState(conv.id, { status: "idle" });
}

async function onReady(conv: Conversation, d: ReadyJson): Promise<void> {
  const product = conv.product_id
    ? await getProductById(conv.product_id)
    : await createProduct({ name: d.product_name, brief: d.brief });
  if (!product) throw new Error("failed to create/load product");
  if (!conv.product_id) {
    await setConversationState(conv.id, { product_id: product.id });
  } else {
    await updateProduct(product.id, { name: d.product_name, brief: d.brief });
  }
  // Resolve team slugs against the catalog so we never persist garbage.
  const team: { slug: string; name: string; role: string }[] = [];
  for (const t of d.team ?? []) {
    const meta = await findAgent(t.slug);
    if (!meta) continue;
    team.push({ slug: meta.slug, name: meta.name, role: t.role || meta.name });
  }
  if (team.length === 0) {
    await sendText(
      conv.wa_chat_id,
      "(PM tried to assemble a team but none of the slugs matched — let me try again)",
    );
    // Push the model back into discovery on next user turn.
    await setConversationState(conv.id, { status: "idle", current_phase: "discovery" });
    return;
  }
  await setAssignments(product.id, team);

  const list = team.map((t) => `• *${t.name}* — ${t.role}`).join("\n");
  await sendBotLine(
    conv,
    "Sarah", "PM",
    `Brief locked. Team I'm pulling in:\n${list}\n\nReply *go* when you want them to start.`,
  );
  await setConversationState(conv.id, {
    status: "idle",
    current_phase: "awaiting_go",
    build_index: 0,
  });
}

// ---------- Awaiting go ----------

const GO_RE = /^\s*(go|yes|y|yep|yeah|ok|okay|proceed|let'?s? (go|do it)|start|ship it|🚀)\s*[.!]*\s*$/i;

async function phaseAwaitingGo(conv: Conversation): Promise<void> {
  const transcript = await loadTranscript(conv.id, 200);
  // Last user message decides.
  const lastUser = [...transcript].reverse().find((m) => m.role === "user");
  if (lastUser && GO_RE.test(lastUser.content)) {
    await sendBotLine(conv, "Sarah", "PM", "Great — kicking off. Listening in if anything needs your call.");
    await setConversationState(conv.id, { current_phase: "build", build_index: 0, status: "running" });
    kickSelf(conv.id);
    return;
  }
  // Not affirmative — let PM re-run (revise brief / team).
  await setConversationState(conv.id, { current_phase: "discovery" });
  const next = await getConversationById(conv.id);
  if (next) await phaseDiscovery(next);
}

// ---------- Build ----------

async function phaseBuild(conv: Conversation): Promise<void> {
  if (!conv.product_id) {
    await sendText(conv.wa_chat_id, "(no product in scope, resetting)");
    await setConversationState(conv.id, { current_phase: "discovery", status: "idle" });
    return;
  }
  const product = await getProductById(conv.product_id);
  if (!product) throw new Error("product missing");
  const assignments = await getAssignments(product.id);
  if (conv.build_index >= assignments.length) {
    await setConversationState(conv.id, { current_phase: "integrate", status: "running" });
    kickSelf(conv.id);
    return;
  }
  const a = assignments[conv.build_index];
  const system = await agentSystem(a.agent_slug, a.agent_role_label, product.brief ?? "");
  const messages = await buildClaudeMessages(conv.id);
  const display = { name: a.agent_display_name, role: a.agent_role_label };

  // Up the token budget — agents produce deliverables.
  const acc = await streamToChat(conv, system, messages, display, { maxTokens: 4096 });
  if (acc === null) return;

  // Split chat from deliverable on the marker.
  const { deliverable } = splitDeliverable(acc.fullText);
  if (deliverable) {
    await postDeliverable(conv, product.id, a.agent_slug, a.agent_display_name, deliverable);
  }

  await setConversationState(conv.id, { build_index: conv.build_index + 1, status: "running" });
  kickSelf(conv.id);
}

// ---------- Integrate ----------

async function phaseIntegrate(conv: Conversation): Promise<void> {
  if (!conv.product_id) {
    await setConversationState(conv.id, { current_phase: "done", status: "done" });
    return;
  }
  const product = await getProductById(conv.product_id);
  if (!product) throw new Error("product missing");
  const system = await integratorSystem(product.brief ?? "");
  const messages = await buildClaudeMessages(conv.id);
  const display = { name: "Marcus", role: "Integrator" };

  const acc = await streamToChat(conv, system, messages, display, { maxTokens: 4096 });
  if (acc === null) return;

  const { deliverable } = splitDeliverable(acc.fullText);
  if (deliverable) {
    await postDeliverable(conv, product.id, "integrator", "Marcus", deliverable, "final-spec");
  }
  await sendBotLine(conv, "Sarah", "PM", "That's the wrap. Anything else, just send a message and I'll spin the team back up.");
  await updateProduct(product.id, { status: "done" });
  await setConversationState(conv.id, { current_phase: "done", status: "done" });
}

// ---------- Done ----------

async function phaseDone(conv: Conversation): Promise<void> {
  // New message after done — treat as start of a new product.
  await setConversationState(conv.id, {
    current_phase: "discovery",
    status: "running",
    product_id: null,
    build_index: 0,
  });
  const next = await getConversationById(conv.id);
  if (next) await phaseDiscovery(next);
}

// ---------- Streaming helpers ----------

type Display = { name: string; role: string };
type Accum = { fullText: string };

async function streamToChat(
  conv: Conversation,
  system: string,
  messages: ChatMsg[],
  display: Display,
  opts: { maxTokens?: number } = {},
): Promise<Accum | null> {
  await setTyping(conv.wa_chat_id, true);
  const ctrl = new AbortController();
  const prefix = `*${display.name} · ${display.role}:*`;
  let firstChunk = true;
  let acc = "";

  try {
    const iter = streamChunks({
      system,
      messages,
      maxTokens: opts.maxTokens,
      abort: ctrl.signal,
    });
    for await (const chunk of iter) {
      if (chunk.text) {
        const visible = stripStructured(chunk.text);
        if (visible) {
          const out = firstChunk ? `${prefix} ${visible}` : visible;
          firstChunk = false;
          await sendText(conv.wa_chat_id, out);
          await recordMessage({
            conversationId: conv.id,
            role: "agent",
            content: out,
            agentDisplayName: display.name,
            agentRoleLabel: display.role,
          });
        }
      }
      acc = chunk.fullText;
      if (chunk.done) break;
      if (await hasPendingInterrupt(conv.id)) {
        ctrl.abort();
        break;
      }
    }
  } finally {
    await setTyping(conv.wa_chat_id, false);
  }

  if (ctrl.signal.aborted) {
    // Interrupt fired. Mark as running (already is) and self-recurse so the
    // next invocation re-reads the updated transcript.
    kickSelf(conv.id);
    return null;
  }
  return { fullText: acc };
}

async function sendBotLine(conv: Conversation, name: string, role: string, text: string): Promise<void> {
  const out = `*${name} · ${role}:* ${text}`;
  await sendText(conv.wa_chat_id, out);
  await recordMessage({
    conversationId: conv.id,
    role: "agent",
    content: out,
    agentDisplayName: name,
    agentRoleLabel: role,
  });
}

// ---------- Transcript shaping ----------

async function buildClaudeMessages(conversationId: string): Promise<ChatMsg[]> {
  const rows = await loadTranscript(conversationId, 300);
  const msgs: ChatMsg[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      msgs.push({ role: "user", content: r.content });
    } else if (r.role === "agent") {
      msgs.push({ role: "assistant", content: r.content });
    }
  }
  if (msgs.length === 0) msgs.push({ role: "user", content: "(no message yet)" });
  // Ensure conversation alternates and starts with user (collapse same-role runs).
  return collapseRuns(msgs);
}

function collapseRuns(msgs: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else out.push({ ...m });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "(start)" });
  return out;
}

// ---------- Output parsing ----------

type ReadyJson = {
  status: "ready";
  product_name?: string;
  brief?: string;
  team?: { slug: string; role: string }[];
};

function parseFinalJson(text: string): ReadyJson | { status: "gathering" } | null {
  const re = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (!last) return null;
  try {
    const j = JSON.parse(last);
    if (j?.status === "ready") return j as ReadyJson;
    if (j?.status === "gathering") return { status: "gathering" };
  } catch { /* fallthrough */ }
  return null;
}

function stripStructured(piece: string): string {
  // Don't leak the JSON fence or the DELIVERABLE marker to the chat.
  let p = piece;
  p = p.replace(/```(?:json)?[\s\S]*?```/g, "").trim();
  p = p.replace(/===DELIVERABLE===[\s\S]*$/g, "").trim();
  return p;
}

function splitDeliverable(full: string): { chat: string; deliverable: string | null } {
  const idx = full.indexOf("===DELIVERABLE===");
  if (idx < 0) return { chat: full, deliverable: null };
  return {
    chat: full.slice(0, idx).trim(),
    deliverable: full.slice(idx + "===DELIVERABLE===".length).trim(),
  };
}

// ---------- Deliverables ----------

async function postDeliverable(
  conv: Conversation,
  productId: string,
  agentSlug: string,
  agentDisplay: string,
  markdown: string,
  basename?: string,
): Promise<void> {
  const safe = (basename ?? agentSlug).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const filename = `${safe}.docx`;
  const bytes = await markdownToDocx(markdown);
  await storeArtifact({ productId, filename, bytes, kind: "docx" });
  const b64 = encodeBase64(bytes);
  await sendDoc(conv.wa_chat_id, filename, b64, `${agentDisplay}: deliverable`);
  await recordMessage({
    conversationId: conv.id,
    role: "system",
    content: `(artifact posted: ${filename})`,
  });
}

// ---------- Utilities ----------

function kickSelf(conversationId: string): void {
  if (!SELF_URL) return;
  const p = fetch(SELF_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": BRIDGE_SECRET },
    body: JSON.stringify({ conversation_id: conversationId }),
  }).then(async (r) => {
    if (!r.ok) console.error("self-kick non-2xx:", r.status, await r.text().catch(() => ""));
  }).catch((e) => console.error("self-kick error:", e));
  const er = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
}

async function safeIdle(conversationId: string): Promise<void> {
  try { await setConversationState(conversationId, { status: "idle" }); }
  catch { /* swallow */ }
}

function shortErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 240 ? s.slice(0, 240) + "…" : s;
}
