// Webhook from the WhatsApp bridge.
// Routes a single inbound message: persists it, decides what to do
// (start a new flow, push an interrupt, or kick the next phase),
// and returns immediately. Heavy lifting happens in run-phase, which is
// invoked via background fetch.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getOrCreateConversation,
  pushInterrupt,
  recordMessage,
  setConversationState,
} from "../_shared/db.ts";

const BRIDGE_SECRET = Deno.env.get("BRIDGE_SECRET") ?? "";
const RUN_PHASE_URL = Deno.env.get("RUN_PHASE_URL") ?? "";

// Hard allowlist on the sender's WhatsApp chat id. For 1:1 chats the
// bridge sets `chat_id = msg.from`, which is the sender's WA id. That
// can be either the legacy phone form (`<digits>@c.us`) OR a privacy
// linked-ID form (`<digits>@lid`) — list every form the owner appears
// under. Defense in depth against a misconfigured bridge.
// `|| default` (not `?? default`) so an empty env string falls back to
// the default — matches bridge behavior and avoids a fail-closed
// configuration where `ALLOWED_WA_CHAT_ID=""` blocks everything.
const ALLOWED_WA_CHAT_IDS = (Deno.env.get("ALLOWED_WA_CHAT_ID") || "201099922763@c.us,37641194070112@lid")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Inbound = {
  chat_id: string;
  wa_message_id?: string;
  from_me?: boolean;
  text: string;
  timestamp?: number;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (req.headers.get("x-bridge-secret") !== BRIDGE_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: Inbound;
  try { body = await req.json(); }
  catch { return new Response("bad json", { status: 400 }); }

  const text = (body.text ?? "").trim();
  if (!text || !body.chat_id) return new Response("noop", { status: 200 });

  if (!ALLOWED_WA_CHAT_IDS.includes(body.chat_id)) {
    console.log(`wa-inbound: dropped ${body.chat_id} (not in allowlist)`);
    return new Response("forbidden", { status: 403 });
  }

  const conv = await getOrCreateConversation(body.chat_id);

  await recordMessage({
    conversationId: conv.id,
    role: "user",
    content: text,
    waMessageId: body.wa_message_id ?? null,
  });

  // Slash-style controls (cheap to support, useful for testing).
  if (text === "/reset") {
    await setConversationState(conv.id, {
      status: "idle",
      current_phase: "discovery",
      product_id: null,
      active_run_id: null,
    });
    return new Response("reset", { status: 200 });
  }

  if (conv.status === "running") {
    // Active agent loop will pick this up between sentences.
    await pushInterrupt(conv.id, text);
    return new Response("interrupt-queued", { status: 200 });
  }

  // idle or done: start (or resume) a phase.
  await setConversationState(conv.id, { status: "running" });
  kickRunPhase(conv.id);
  return new Response("kicked", { status: 200 });
});

function kickRunPhase(conversationId: string): void {
  if (!RUN_PHASE_URL) {
    console.error("RUN_PHASE_URL not set");
    return;
  }
  const promise = fetch(RUN_PHASE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-secret": BRIDGE_SECRET,
    },
    body: JSON.stringify({ conversation_id: conversationId }),
  }).then(async (r) => {
    if (!r.ok) console.error("run-phase kick non-2xx:", r.status, await r.text().catch(() => ""));
  }).catch((e) => console.error("run-phase kick error:", e));

  // EdgeRuntime.waitUntil is available in Supabase Edge Runtime.
  const er = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(promise);
}
