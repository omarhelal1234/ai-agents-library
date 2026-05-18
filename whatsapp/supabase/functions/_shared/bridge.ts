// Client for the WhatsApp bridge (Node service on Railway).
// All calls require a shared bearer secret.

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function normalizeBaseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

async function call(path: string, body: unknown): Promise<Response> {
  const url = normalizeBaseUrl(mustEnv("BRIDGE_URL"));
  const secret = mustEnv("BRIDGE_SECRET");
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-secret": secret,
    },
    body: JSON.stringify(body),
  });
  return res;
}

export async function sendText(chatId: string, text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const res = await call("/send", { chat_id: chatId, text });
  if (!res.ok) {
    console.error("bridge send failed", res.status, await res.text());
    return null;
  }
  const j = await res.json().catch(() => ({}));
  return j.wa_message_id ?? null;
}

export async function sendDoc(
  chatId: string,
  filename: string,
  base64: string,
  caption?: string,
): Promise<string | null> {
  const res = await call("/send-doc", {
    chat_id: chatId,
    filename,
    base64,
    caption,
  });
  if (!res.ok) {
    console.error("bridge send-doc failed", res.status, await res.text());
    return null;
  }
  const j = await res.json().catch(() => ({}));
  return j.wa_message_id ?? null;
}

export async function setTyping(chatId: string, on: boolean): Promise<void> {
  await call("/typing", { chat_id: chatId, on }).catch(() => {});
}
