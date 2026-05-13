// API clients for Anthropic and OpenAI, runnable directly from the browser.
// Both providers expose CORS-enabled endpoints; keys live in localStorage only.

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5-20250929"; // orchestration + integration
const DEFAULT_GPT_MODEL = "gpt-4o-mini";                   // fast worker default

// ---------------------------------------------------------------- Anthropic
export async function callClaude({
  apiKey,
  system,
  messages,
  model = DEFAULT_CLAUDE_MODEL,
  max_tokens = 4096,
  temperature = 0.4,
  signal,
}) {
  if (!apiKey) throw new Error("Missing Anthropic API key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens,
      temperature,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, raw: data, usage: data.usage };
}

// Streaming Anthropic call — keeps the connection alive with SSE chunks,
// preventing Safari/WebKit "Load failed" on long-running integrator requests.
export async function callClaudeStream({
  apiKey,
  system,
  messages,
  model = DEFAULT_CLAUDE_MODEL,
  max_tokens = 4096,
  temperature = 0.4,
  signal,
}) {
  if (!apiKey) throw new Error("Missing Anthropic API key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens,
      temperature,
      system,
      messages,
      stream: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete last line in buffer
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          text += evt.delta.text;
        } else if (evt.type === "message_delta" && evt.usage) {
          usage = { ...usage, ...evt.usage };
        } else if (evt.type === "message_start" && evt.message?.usage) {
          usage = { ...usage, ...evt.message.usage };
        }
      } catch {}
    }
  }
  return { text, usage };
}

// ---------------------------------------------------------------- OpenAI
export async function callOpenAI({
  apiKey,
  system,
  messages,
  model = DEFAULT_GPT_MODEL,
  max_tokens = 4096,
  temperature = 0.4,
  signal,
}) {
  if (!apiKey) throw new Error("Missing OpenAI API key");
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of messages) msgs.push(m);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model,
      messages: msgs,
      max_tokens,
      temperature,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return { text, raw: data, usage: data.usage };
}

// ---------------------------------------------------------------- Routing
// Pick which provider runs a worker.
//   - If model = "openai" but no OpenAI key, fall back to Claude
//   - If model unspecified, default by division
export function pickModel({ requested, division, hasOpenAI }) {
  const m = (requested || "").toLowerCase();
  if (m === "claude" || m === "anthropic") return "claude";
  if ((m === "openai" || m === "gpt") && hasOpenAI) return "openai";
  if (m === "openai" || m === "gpt") return "claude"; // fallback

  // Default routing — engineering/testing → Claude; copy/marketing → OpenAI when available
  const claudeDiv = new Set([
    "Engineering", "Testing", "Spatial Computing", "Game Development",
    "Specialized", "Product", "Project Management", "Academic",
  ]);
  if (claudeDiv.has(division)) return "claude";
  return hasOpenAI ? "openai" : "claude";
}

export async function runWorker({ provider, anthropicKey, openaiKey, system, user, signal }) {
  const messages = [{ role: "user", content: user }];
  if (provider === "openai") {
    return callOpenAI({ apiKey: openaiKey, system, messages, signal, temperature: 0.5 });
  }
  return callClaude({ apiKey: anthropicKey, system, messages, signal, temperature: 0.4 });
}

// JSON-strict Claude call — used for orchestrator + integrator.
// Strips ```json fences and extracts the first JSON object/array.
export async function callClaudeJSON({ apiKey, system, user, max_tokens = 6000, model, signal }) {
  const { text, usage } = await callClaude({
    apiKey, system, model,
    messages: [{ role: "user", content: user }],
    max_tokens, temperature: 0.2, signal,
  });
  return { parsed: extractJSON(text), text, usage };
}

export function extractJSON(text) {
  if (!text) throw new Error("Empty response");
  let t = text.trim();

  // Only strip markdown fences if the content doesn't start with { or [
  // (the lazy regex can grab a fence INSIDE a JSON string value and corrupt the parse)
  if (t[0] !== "{" && t[0] !== "[") {
    // Use greedy match to grab from first opening fence to LAST closing fence
    const fence = t.match(/```(?:json)?\s*([\s\S]*)```\s*$/i);
    if (fence) t = fence[1].trim();
  }

  // Find first { or [
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) throw new Error("No JSON found in response");
  // Balance braces — track both {} and [] depths for proper nesting
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let objDepth = 0, arrDepth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') objDepth++;
    else if (c === '}') objDepth--;
    else if (c === '[') arrDepth++;
    else if (c === ']') arrDepth--;
    // We're done when we close the outermost bracket we started with
    if (open === '{' && objDepth === 0 && arrDepth === 0 && c === '}') { end = i + 1; break; }
    if (open === '[' && objDepth === 0 && arrDepth === 0 && c === ']') { end = i + 1; break; }
  }
  if (end === -1) {
    // Attempt to repair truncated JSON (output hit max_tokens)
    const repaired = repairTruncatedJSON(t.slice(start));
    if (repaired) return repaired;
    throw new Error("Unbalanced JSON in response");
  }
  const json = t.slice(start, end);
  try { return JSON.parse(json); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}\n--- text ---\n${json.slice(0,400)}`); }
}

// Attempt to recover a usable integrator response from truncated JSON.
// Strategy: find all complete {"path":...,"content":...} objects in the files array,
// close the structure, and return what we have.
function repairTruncatedJSON(raw) {
  try {
    // Find the "files" array start
    const filesIdx = raw.indexOf('"files"');
    if (filesIdx === -1) return null;
    const arrStart = raw.indexOf('[', filesIdx);
    if (arrStart === -1) return null;

    // Collect complete file objects by scanning for balanced {}
    const files = [];
    let i = arrStart + 1;
    while (i < raw.length) {
      // Find next object start
      while (i < raw.length && raw[i] !== '{') i++;
      if (i >= raw.length) break;
      // Find balanced end of this object
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let j = i; j < raw.length; j++) {
        const c = raw[j];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      if (end === -1) break; // truncated mid-object — discard
      try {
        const obj = JSON.parse(raw.slice(i, end));
        if (typeof obj.path === 'string' && typeof obj.content === 'string') {
          files.push(obj);
        }
      } catch { /* skip malformed */ }
      i = end;
    }
    if (files.length === 0) return null;

    // Try to extract summary/homepageHint from before the files array
    let summary = "";
    let homepageHint = "index.html";
    const sumMatch = raw.match(/"summary"\s*:\s*"([^"]*)"/); 
    if (sumMatch) summary = sumMatch[1];
    const hpMatch = raw.match(/"homepageHint"\s*:\s*"([^"]*)"/); 
    if (hpMatch) homepageHint = hpMatch[1];

    return { files, summary, homepageHint, _repaired: true };
  } catch {
    return null;
  }
}
