// Postgres client (service-role) for Edge Functions.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (_client) return _client;
  const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PROJECT_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase URL/service-role env not set");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export type Conversation = {
  id: string;
  wa_chat_id: string;
  product_id: string | null;
  status: string;
  current_phase: string;
  active_run_id: string | null;
  build_index: number;
};

export type Product = {
  id: string;
  name: string | null;
  brief: string | null;
  status: string;
  deploy_url: string | null;
};

export async function getOrCreateConversation(waChatId: string): Promise<Conversation> {
  const s = db();
  const found = await s.from("wa_conversations").select("*").eq("wa_chat_id", waChatId).maybeSingle();
  if (found.data) return found.data as Conversation;
  const created = await s
    .from("wa_conversations")
    .insert({ wa_chat_id: waChatId })
    .select("*")
    .single();
  if (created.error) throw created.error;
  return created.data as Conversation;
}

export async function recordMessage(args: {
  conversationId: string;
  role: "user" | "agent" | "system";
  content: string;
  agentSlug?: string;
  agentDisplayName?: string;
  agentRoleLabel?: string;
  waMessageId?: string | null;
}): Promise<void> {
  const s = db();
  const { error } = await s.from("wa_messages").insert({
    conversation_id: args.conversationId,
    role: args.role,
    content: args.content,
    agent_slug: args.agentSlug ?? null,
    agent_display_name: args.agentDisplayName ?? null,
    agent_role_label: args.agentRoleLabel ?? null,
    wa_message_id: args.waMessageId ?? null,
  });
  if (error) console.error("recordMessage", error);
}

export async function loadTranscript(conversationId: string, limit = 200) {
  const s = db();
  const { data, error } = await s
    .from("wa_messages")
    .select("role, agent_display_name, agent_role_label, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getConversationById(id: string): Promise<Conversation | null> {
  const s = db();
  const { data, error } = await s.from("wa_conversations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Conversation) ?? null;
}

export async function getProductById(id: string): Promise<Product | null> {
  const s = db();
  const { data, error } = await s.from("wa_products").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Product) ?? null;
}

export async function setConversationState(
  conversationId: string,
  patch: Partial<Pick<Conversation, "status" | "current_phase" | "product_id" | "active_run_id" | "build_index">>,
): Promise<void> {
  const s = db();
  const { error } = await s.from("wa_conversations").update(patch).eq("id", conversationId);
  if (error) throw error;
}

export async function createProduct(args: { name?: string; brief?: string }): Promise<Product> {
  const s = db();
  const { data, error } = await s
    .from("wa_products")
    .insert({ name: args.name ?? null, brief: args.brief ?? null })
    .select("*")
    .single();
  if (error) throw error;
  return data as Product;
}

export async function updateProduct(
  productId: string,
  patch: Partial<Product>,
): Promise<void> {
  const s = db();
  const { error } = await s.from("wa_products").update(patch).eq("id", productId);
  if (error) throw error;
}

export async function setAssignments(
  productId: string,
  team: { slug: string; name: string; role: string }[],
): Promise<void> {
  const s = db();
  await s.from("wa_assignments").delete().eq("product_id", productId);
  if (team.length === 0) return;
  const rows = team.map((t) => ({
    product_id: productId,
    agent_slug: t.slug,
    agent_display_name: t.name,
    agent_role_label: t.role,
  }));
  const { error } = await s.from("wa_assignments").insert(rows);
  if (error) throw error;
}

export async function getAssignments(productId: string) {
  const s = db();
  const { data, error } = await s
    .from("wa_assignments")
    .select("agent_slug, agent_display_name, agent_role_label, assigned_at")
    .eq("product_id", productId)
    .order("assigned_at");
  if (error) throw error;
  return data ?? [];
}

export async function pushInterrupt(conversationId: string, content: string): Promise<void> {
  const s = db();
  const { error } = await s
    .from("wa_interrupts")
    .insert({ conversation_id: conversationId, content });
  if (error) console.error("pushInterrupt", error);
}

export async function hasPendingInterrupt(conversationId: string): Promise<boolean> {
  const s = db();
  const { count, error } = await s
    .from("wa_interrupts")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("consumed", false);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function consumePendingInterrupts(conversationId: string): Promise<string[]> {
  const s = db();
  const sel = await s
    .from("wa_interrupts")
    .select("id, content")
    .eq("conversation_id", conversationId)
    .eq("consumed", false)
    .order("created_at");
  if (sel.error) throw sel.error;
  const rows = sel.data ?? [];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await s.from("wa_interrupts").update({ consumed: true }).in("id", ids);
  return rows.map((r) => r.content);
}

export async function storeArtifact(args: {
  productId: string;
  filename: string;
  bytes: Uint8Array;
  kind: string;
}): Promise<{ storagePath: string }> {
  const s = db();
  const storagePath = `${args.productId}/${Date.now()}-${args.filename}`;
  const up = await s.storage.from("wa-artifacts").upload(storagePath, args.bytes, {
    contentType: args.kind === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/octet-stream",
    upsert: false,
  });
  if (up.error) throw up.error;
  const { error } = await s.from("wa_artifacts").insert({
    product_id: args.productId,
    filename: args.filename,
    storage_path: storagePath,
    kind: args.kind,
    size_bytes: args.bytes.byteLength,
  });
  if (error) throw error;
  return { storagePath };
}
