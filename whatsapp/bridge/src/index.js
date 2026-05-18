// WhatsApp <-> Supabase bridge.
//
// One Node process. Holds the whatsapp-web.js session (LocalAuth on a
// persistent volume). Forwards inbound messages to a Supabase Edge Function
// webhook, and exposes a small HTTP API for outbound sends.
//
// Auth between this bridge and Supabase is a shared bearer secret in
// BRIDGE_SECRET, set on both sides.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import qrTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import { fetch } from "undici";
import wweb from "whatsapp-web.js";

const { Client, LocalAuth, MessageMedia } = wweb;

const PORT = Number(process.env.PORT || 8080);
const BRIDGE_SECRET = required("BRIDGE_SECRET");
const SUPABASE_WEBHOOK_URL = required("SUPABASE_WEBHOOK_URL");
const SUPABASE_SERVICE_ROLE = required("SUPABASE_SERVICE_ROLE");
const SESSION_DIR = process.env.SESSION_DIR || "/data/wweb-session";
const OWNER_WA_ID = process.env.OWNER_WA_ID || ""; // optional: only react to this number

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  },
});

let ready = false;
let latestQr = null;

client.on("qr", (qr) => {
  latestQr = qr;
  console.log("--- SCAN THIS QR WITH WHATSAPP > LINKED DEVICES ---");
  qrTerminal.generate(qr, { small: true });
  console.log(`--- or open https://<your-railway-domain>/qr in a browser ---`);
});

client.on("authenticated", () => console.log("authenticated"));
client.on("auth_failure", (m) => console.error("auth_failure:", m));
client.on("disconnected", (r) => {
  console.error("disconnected:", r);
  process.exit(1); // Railway restarts; session persists on volume
});

client.on("ready", () => {
  ready = true;
  latestQr = null;
  console.log("ready. me =", client.info?.wid?._serialized);
});

async function handleInbound(msg, source) {
  try {
    console.log(`[${source}] from=${msg.from} fromMe=${msg.fromMe} type=${msg.type} hasBody=${!!msg.body}`);
    if (msg.fromMe) return;                       // skip our own sends
    if (msg.from === "status@broadcast") return;
    if (msg.from.endsWith("@g.us")) return;
    if (OWNER_WA_ID && msg.from !== OWNER_WA_ID) {
      console.log(`[${source}] dropped by OWNER_WA_ID filter (expected ${OWNER_WA_ID})`);
      return;
    }

    const payload = {
      chat_id: msg.from,
      wa_message_id: msg.id?._serialized,
      from_me: false,
      text: msg.body || "",
      timestamp: msg.timestamp,
    };
    const res = await fetch(SUPABASE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "x-bridge-secret": BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("webhook non-2xx:", res.status, await res.text());
    } else {
      console.log(`[${source}] forwarded to Supabase ok`);
    }
  } catch (e) {
    console.error("inbound handler error:", e);
  }
}

// Listen on BOTH events. `message` is the canonical inbound event,
// `message_create` is the catch-all (incoming + outgoing). For senders the
// linked-device session hasn't cached, `message` sometimes silently misses
// the first message of a fresh chat — `message_create` reliably catches it.
client.on("message", (msg) => handleInbound(msg, "message"));
client.on("message_create", (msg) => {
  if (msg.fromMe) return;                          // skip echoes of our own sends
  handleInbound(msg, "message_create");
});

const app = express();
app.use(express.json({ limit: "20mb" }));

// /qr is intentionally unauthenticated — the QR string IS the auth handshake;
// it's only present briefly while pairing, and the value is single-use.
app.get("/qr", async (_req, res) => {
  if (ready) return res.status(200).send(html("Already linked. No QR needed.", null));
  if (!latestQr) return res.status(200).send(html("No QR yet — waiting for WhatsApp client to start. Refresh in a few seconds.", null));
  try {
    const svg = await QRCode.toString(latestQr, { type: "svg", margin: 1, width: 320 });
    res.set("content-type", "text/html").send(html("Scan with WhatsApp → Settings → Linked Devices", svg));
  } catch (e) {
    res.status(500).send(html(`QR render error: ${e}`, null));
  }
});

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.header("x-bridge-secret") !== BRIDGE_SECRET) {
    return res.status(401).json({ error: "bad bridge secret" });
  }
  if (!ready) return res.status(503).json({ error: "not ready" });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, ready }));

function html(title, svg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>WA bridge QR</title>
<style>body{font-family:system-ui;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}h1{font-weight:500;font-size:18px;margin:0 0 24px}svg{background:#fff;padding:16px;border-radius:8px}</style>
</head><body><h1>${title}</h1>${svg ?? ""}</body></html>`;
}

app.post("/send", async (req, res) => {
  const { chat_id, text } = req.body || {};
  if (!chat_id || typeof text !== "string") {
    return res.status(400).json({ error: "chat_id and text required" });
  }
  try {
    const sent = await client.sendMessage(chat_id, text);
    res.json({ ok: true, wa_message_id: sent.id?._serialized });
  } catch (e) {
    console.error("send error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/send-doc", async (req, res) => {
  const { chat_id, filename, base64, mimetype, caption } = req.body || {};
  if (!chat_id || !filename || !base64) {
    return res.status(400).json({ error: "chat_id, filename, base64 required" });
  }
  try {
    const media = new MessageMedia(
      mimetype || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64,
      filename,
    );
    const sent = await client.sendMessage(chat_id, media, { caption: caption || undefined });
    res.json({ ok: true, wa_message_id: sent.id?._serialized });
  } catch (e) {
    console.error("send-doc error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/typing", async (req, res) => {
  const { chat_id, on } = req.body || {};
  if (!chat_id) return res.status(400).json({ error: "chat_id required" });
  try {
    const chat = await client.getChatById(chat_id);
    if (on === false) await chat.clearState();
    else await chat.sendStateTyping();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`bridge http on :${PORT}`));

// Chromium leaves Singleton* lock files in the profile dir. When the container
// is killed mid-run, those locks persist on the mounted volume and the next
// boot thinks another browser is alive. Sweep them before initializing.
function cleanChromiumLocks(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        cleanChromiumLocks(p);
      } else if (/^Singleton(Lock|Cookie|Socket)$/.test(entry.name)) {
        try { fs.rmSync(p, { force: true }); console.log("removed stale lock:", p); }
        catch (e) { console.error("could not remove", p, e); }
      }
    }
  } catch (e) {
    console.error("lock sweep error:", e);
  }
}
cleanChromiumLocks(SESSION_DIR);

client.initialize().catch((e) => {
  console.error("initialize failed:", e);
  process.exit(1);
});
