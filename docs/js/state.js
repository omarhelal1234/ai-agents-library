// State store for the orchestrator.
// Primary: a dedicated Supabase project (durable, queryable, cross-device).
// Fallback: localStorage (transient, single-browser).
//
// Schema (Supabase):
//   runs:                 the high-level run record — idea, plan, status, repo/supabase refs
//   agent_outputs:        per-agent output, status, error, retry count
//   integrator_outputs:   raw integrator response + parsed file tree
//   change_requests:      CRs against shipped runs (re-run agents with new tasks)
//
// All tables: anon-key writable for now. Tighten with RLS once auth lands.

const LS_KEY = "agency.state.v2";   // local cache mirror
const LEGACY_KEY = "agency.runs";   // pre-state-driven run history

// ----- config -----
// The orchestrator's own Supabase project. Auto-seeded via window.AGENCY_CONFIG
// (state.supabaseUrl / state.supabaseAnonKey) or settings panel.
function getStateConfig() {
  const cfg = (window.AGENCY_CONFIG && window.AGENCY_CONFIG.state) || {};
  return {
    url:  localStorage.getItem("agency.state.url")     || cfg.supabaseUrl     || "",
    key:  localStorage.getItem("agency.state.anonKey") || cfg.supabaseAnonKey || "",
  };
}
export function setStateConfig({ url, key }) {
  if (url) localStorage.setItem("agency.state.url", url);
  if (key) localStorage.setItem("agency.state.anonKey", key);
}
export function hasStateBackend() {
  const c = getStateConfig();
  return !!(c.url && c.key);
}

// ----- low-level: REST helpers via PostgREST -----
async function rest(path, init = {}) {
  const c = getStateConfig();
  if (!c.url || !c.key) throw new Error("State backend not configured");
  const url = `${c.url.replace(/\/$/, "")}/rest/v1${path}`;
  const headers = {
    "apikey": c.key,
    "Authorization": `Bearer ${c.key}`,
    "Content-Type": "application/json",
    "Prefer": init.prefer || "return=representation",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status} ${path}: ${txt.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ----- localStorage cache -----
function cacheRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
  catch { return {}; }
}
function cacheWrite(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); }
  catch { /* quota — drop oldest */ }
}
function cacheUpsertRun(run) {
  const all = cacheRead();
  all[run.id] = run;
  cacheWrite(all);
}
function cacheListRuns() {
  const all = cacheRead();
  return Object.values(all).sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
}

// ----- public API -----

// Create a run shell with status="planning" — call this first.
export async function createRun({ idea }) {
  const run = {
    id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    idea,
    status: "planning",          // planning | provisioning | running | integrating | publishing | shipped | failed
    current_step: "plan",        // plan | provision | work | integrate | publish | done
    plan: null,                  // full plan JSON once produced
    repo_url: null,
    repo_full_name: null,
    repo_default_branch: null,
    supabase_ref: null,
    supabase_url: null,
    supabase_anon_key: null,
    supabase_db_password: null,
    pages_url: null,
    integrator_raw: null,        // raw integrator text (set even on parse failure)
    integrator_files: null,      // parsed { files, summary, homepageHint }
    error: null,
    retry_counts: {},            // step name -> int
  };
  cacheUpsertRun(run);
  if (hasStateBackend()) {
    try {
      await rest("/runs", { method: "POST", body: JSON.stringify(run) });
    } catch (e) {
      console.warn("[state] createRun: Supabase write failed, using local cache only:", e.message);
    }
  }
  return run;
}

// Patch fields on an existing run. Writes through to Supabase if configured.
export async function updateRun(id, patch) {
  const all = cacheRead();
  const existing = all[id] || { id };
  const merged = { ...existing, ...patch, updated_at: new Date().toISOString() };
  all[id] = merged;
  cacheWrite(all);
  if (hasStateBackend()) {
    try {
      await rest(`/runs?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...patch, updated_at: merged.updated_at }),
      });
    } catch (e) {
      console.warn("[state] updateRun: Supabase write failed:", e.message);
    }
  }
  return merged;
}

// Get a run by id — prefers Supabase, falls back to cache.
export async function getRun(id) {
  if (hasStateBackend()) {
    try {
      const rows = await rest(`/runs?id=eq.${encodeURIComponent(id)}&select=*`);
      if (Array.isArray(rows) && rows[0]) {
        // Hydrate agent outputs + integrator output
        const ao = await rest(`/agent_outputs?run_id=eq.${encodeURIComponent(id)}&select=*`).catch(() => []);
        const ints = await rest(`/integrator_outputs?run_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.desc&limit=1`).catch(() => []);
        const run = rows[0];
        run.agent_outputs = ao || [];
        run.integrator = (ints && ints[0]) || null;
        cacheUpsertRun(run);
        return run;
      }
    } catch (e) {
      console.warn("[state] getRun: Supabase read failed, falling back:", e.message);
    }
  }
  return cacheRead()[id] || null;
}

// List runs — prefers Supabase.
export async function listRuns({ limit = 50 } = {}) {
  if (hasStateBackend()) {
    try {
      const rows = await rest(`/runs?select=*&order=started_at.desc&limit=${limit}`);
      if (Array.isArray(rows)) {
        // Refresh cache
        const all = {};
        for (const r of rows) all[r.id] = r;
        cacheWrite(all);
        return rows;
      }
    } catch (e) {
      console.warn("[state] listRuns: Supabase read failed, falling back:", e.message);
    }
  }
  return cacheListRuns().slice(0, limit);
}

// Save / update one agent's output. Upsert by (run_id, slug).
export async function saveAgentOutput({ runId, slug, name, division, provider, phase, status, output, error, usage, attempt }) {
  const row = {
    run_id: runId,
    slug,
    name: name || slug,
    division: division || "",
    provider: provider || "",
    phase: phase || 1,
    status,                         // queued | running | done | failed | skipped
    output: output || null,
    error: error || null,
    usage: usage || null,
    attempt: attempt ?? 1,
    updated_at: new Date().toISOString(),
  };
  // Cache too — store under run.agent_outputs[slug]
  const all = cacheRead();
  if (all[runId]) {
    all[runId].agent_outputs = all[runId].agent_outputs || {};
    all[runId].agent_outputs[slug] = row;
    cacheWrite(all);
  }
  if (hasStateBackend()) {
    try {
      await rest(`/agent_outputs?on_conflict=run_id,slug`, {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: JSON.stringify(row),
      });
    } catch (e) {
      console.warn("[state] saveAgentOutput failed:", e.message);
    }
  }
  return row;
}

// Get all agent outputs for a run.
export async function getAgentOutputs(runId) {
  if (hasStateBackend()) {
    try {
      const rows = await rest(`/agent_outputs?run_id=eq.${encodeURIComponent(runId)}&select=*&order=phase.asc`);
      if (Array.isArray(rows)) return rows;
    } catch (e) {
      console.warn("[state] getAgentOutputs failed, using cache:", e.message);
    }
  }
  const r = cacheRead()[runId];
  return r && r.agent_outputs ? Object.values(r.agent_outputs) : [];
}

// Save integrator output — raw text always; parsed only on success.
export async function saveIntegratorOutput({ runId, raw, parsed, error, attempt }) {
  const row = {
    run_id: runId,
    raw: raw || null,
    parsed: parsed || null,
    error: error || null,
    attempt: attempt ?? 1,
    created_at: new Date().toISOString(),
  };
  const all = cacheRead();
  if (all[runId]) {
    all[runId].integrator = row;
    cacheWrite(all);
  }
  if (hasStateBackend()) {
    try {
      await rest(`/integrator_outputs`, {
        method: "POST",
        body: JSON.stringify(row),
      });
    } catch (e) {
      console.warn("[state] saveIntegratorOutput failed:", e.message);
    }
  }
  return row;
}

// ----- change requests -----
export async function createChangeRequest({ runId, description, agentSlugs, newTasks }) {
  const cr = {
    id: crypto.randomUUID(),
    run_id: runId,
    description: description || "",
    agent_slugs: agentSlugs || [],
    new_tasks: newTasks || {},   // map of slug -> task text
    status: "pending",
    created_at: new Date().toISOString(),
  };
  if (hasStateBackend()) {
    try {
      await rest(`/change_requests`, {
        method: "POST",
        body: JSON.stringify(cr),
      });
    } catch (e) {
      console.warn("[state] createChangeRequest failed:", e.message);
    }
  }
  return cr;
}

export async function updateChangeRequest(id, patch) {
  if (hasStateBackend()) {
    try {
      await rest(`/change_requests?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    } catch (e) {
      console.warn("[state] updateChangeRequest failed:", e.message);
    }
  }
}

// =====================================================================
// Encrypted secrets (API keys, tokens) stored in Supabase.
// Plaintext never leaves the browser — encryption via crypto.js + passphrase.
// =====================================================================
import { encrypt, decrypt } from "./crypto.js";

// Save a map of name -> plaintext. Each is encrypted with the passphrase and upserted.
export async function saveSecrets(secrets, passphrase) {
  if (!hasStateBackend()) throw new Error("State backend not configured — cannot save encrypted secrets");
  if (!passphrase) throw new Error("Passphrase required to save secrets");
  const rows = [];
  for (const [name, plaintext] of Object.entries(secrets || {})) {
    if (plaintext == null || plaintext === "") continue;
    const enc = await encrypt(String(plaintext), passphrase);
    rows.push({
      name,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      salt: enc.salt,
      algo: enc.algo,
      kdf: enc.kdf,
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) return [];
  // Upsert on conflict(name)
  return rest(`/secrets?on_conflict=name`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(rows),
  });
}

// Load all secrets, decrypting with the passphrase. Returns name -> plaintext map.
// Throws if decryption fails (wrong passphrase or corrupted ciphertext).
export async function loadSecrets(passphrase) {
  if (!hasStateBackend()) return {};
  if (!passphrase) throw new Error("Passphrase required to load secrets");
  const rows = await rest(`/secrets?select=*`);
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const out = {};
  for (const r of rows) {
    out[r.name] = await decrypt({ ciphertext: r.ciphertext, iv: r.iv, salt: r.salt }, passphrase);
  }
  return out;
}

// List which secret names are stored (no decryption needed).
export async function listSecretNames() {
  if (!hasStateBackend()) return [];
  try {
    const rows = await rest(`/secrets?select=name,updated_at`);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn("[state] listSecretNames failed:", e.message);
    return [];
  }
}

// Fetch one canary record (any) so we can verify the passphrase without
// pulling and decrypting every secret.
export async function getCanarySecret() {
  if (!hasStateBackend()) return null;
  try {
    const rows = await rest(`/secrets?select=ciphertext,iv,salt&limit=1`);
    if (Array.isArray(rows) && rows[0]) return rows[0];
  } catch {}
  return null;
}

export async function deleteSecret(name) {
  if (!hasStateBackend()) return;
  await rest(`/secrets?name=eq.${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ----- one-time migration from legacy `agency.runs` (best-effort) -----
export function migrateLegacyRuns() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const list = JSON.parse(raw);
    const all = cacheRead();
    let migrated = 0;
    for (const r of list) {
      if (!r || !r.id) continue;
      if (all[r.id]) continue;
      all[r.id] = {
        id: r.id,
        started_at: r.startedAt || new Date().toISOString(),
        updated_at: r.startedAt || new Date().toISOString(),
        idea: r.idea || "",
        status: r.status === "shipped" ? "shipped" : (r.status === "failed" ? "failed" : "unknown"),
        current_step: r.status === "shipped" ? "done" : "unknown",
        plan: { projectName: r.projectName, projectTitle: r.projectTitle, team: (r.team || []).map((s) => ({ slug: s })) },
        repo_url: r.repoUrl || null,
        repo_full_name: r.repoFullName || null,
        supabase_ref: r.supabaseRef || null,
        supabase_url: r.supabaseUrl || null,
        pages_url: r.pagesUrl || null,
        error: r.error || null,
        legacy: true,
      };
      migrated++;
    }
    if (migrated > 0) cacheWrite(all);
    localStorage.setItem(LEGACY_KEY + ".migrated", "1");
    return migrated;
  } catch {
    return 0;
  }
}
