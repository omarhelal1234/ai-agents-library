// Supabase Management API client for browser use.
// Auth: personal access token from https://supabase.com/dashboard/account/tokens
//
// The Management API doesn't include the right CORS headers for arbitrary
// origins (github.io etc.), so calls from a browser SPA are blocked. To work
// around this, we route every request through an Edge Function proxy that
// lives on a Supabase project YOU control. The proxy ONLY forwards the
// request to api.supabase.com — it never reads, writes, or creates anything
// in that host project. Every new project the orchestrator provisions is
// still a separate, fresh project in your org.
//
// Set window.AGENCY_CONFIG.supaProxyBase = "https://<ref>.supabase.co/functions/v1/mgmt-proxy"
// to enable. Falls back to api.supabase.com when not set (only works server-side).

function apiBase() {
  const cfg = (typeof window !== "undefined" && window.AGENCY_CONFIG) || {};
  return cfg.supaProxyBase || "https://api.supabase.com";
}

function headers(token, json = true) {
  const h = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function sb(token, path, init = {}) {
  const url = `${apiBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...headers(token, init.body != null), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status} ${init.method || "GET"} ${path}: ${txt.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listOrganizations(token) {
  return sb(token, `/v1/organizations`);
}

// Generate a random secure DB password (>=24 chars, mixed)
export function genDbPassword() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_!@#%";
  let out = "";
  for (let i = 0; i < arr.length; i++) out += alphabet[arr[i] % alphabet.length];
  return out + "Aa9!";
}

export async function createProject(token, { name, organizationId, region = "us-east-1", dbPassword, plan = "free" }) {
  return sb(token, `/v1/projects`, {
    method: "POST",
    body: JSON.stringify({
      name,
      organization_id: organizationId,
      db_pass: dbPassword,
      region,
      plan,
    }),
  });
}

export async function getProject(token, ref) {
  return sb(token, `/v1/projects/${ref}`);
}

export async function listProjects(token) {
  return sb(token, `/v1/projects`);
}

export async function waitForProjectActive(token, ref, { timeoutMs = 180_000, intervalMs = 5_000, onTick } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await getProject(token, ref).catch(() => null);
    if (onTick) onTick(p?.status || "unknown");
    if (p && p.status === "ACTIVE_HEALTHY") return p;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Supabase project ${ref} did not reach ACTIVE_HEALTHY within ${timeoutMs}ms`);
}

export async function getApiKeys(token, ref) {
  return sb(token, `/v1/projects/${ref}/api-keys`);
}

export async function runSQL(token, ref, query) {
  return sb(token, `/v1/projects/${ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

export function projectUrlFromRef(ref) {
  return `https://${ref}.supabase.co`;
}

export function slugifyProjectName(name) {
  return (name || "agency-project")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60) || "agency-project";
}
