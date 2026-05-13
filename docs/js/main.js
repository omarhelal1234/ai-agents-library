// Main controller — wires UI events to the orchestrator, runner, and publishers.
//
// State-driven pipeline:
//   1. Every run gets a persistent record in Supabase (via state.js).
//   2. Each step (plan, provision, work, integrate, publish) updates state
//      *before and after* the heavy lifting. A crash mid-step leaves the run
//      in a recoverable state.
//   3. Per-agent outputs are written as soon as they complete, so a failed
//      integrator does not erase the work of 10 successful agents.
//   4. Failed runs expose a "Resume" button; shipped runs expose "Request change".

import { loadRegistry, getRegistry, agentsByDivision, getAgentBySlug } from "./agents.js";
import { planTeam, integrateOutputs } from "./orchestrator.js";
import { createRunner } from "./runner.js";
import * as gh from "./github.js";
import * as sb from "./supabase.js";
import * as state from "./state.js";
import * as cryptoMod from "./crypto.js";
import { retryAsync } from "./retry.js";

// =====================================================================
// Encrypted secrets — in-memory cache loaded from Supabase on demand.
// localStorage no longer holds API keys after migration.
// =====================================================================
const SECRET_NAMES = ["anthropic", "openai", "github", "supabase"];
let _decryptedSecrets = null;   // map of name -> plaintext after successful load

// Prompt for passphrase if not already cached. Returns the passphrase or null.
async function ensurePassphrase({ purpose = "access encrypted secrets", verify = true } = {}) {
  let pass = cryptoMod.getPassphrase();
  if (pass) return pass;
  // If we need to verify, pull the canary first
  let canary = null;
  if (verify) {
    try { canary = await state.getCanarySecret(); } catch {}
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const entered = prompt(
      `Passphrase to ${purpose}` +
      (attempt > 0 ? "\n\n(Wrong passphrase — try again)" : "") +
      "\n\nThis stays in memory only; cleared when you close the tab."
    );
    if (!entered) return null;
    if (!canary) {
      // No canary yet (first setup) — accept and store
      cryptoMod.setPassphrase(entered);
      return entered;
    }
    const ok = await cryptoMod.verifyPassphrase(canary, entered);
    if (ok) {
      cryptoMod.setPassphrase(entered);
      return entered;
    }
  }
  alert("Could not verify passphrase. Aborting.");
  return null;
}

// Pull encrypted secrets from Supabase into the in-memory cache.
async function loadEncryptedSecrets() {
  if (!state.hasStateBackend()) return null;
  const names = await state.listSecretNames();
  if (!names || names.length === 0) return null;
  const pass = await ensurePassphrase({ purpose: "decrypt your API keys" });
  if (!pass) return null;
  try {
    _decryptedSecrets = await state.loadSecrets(pass);
    return _decryptedSecrets;
  } catch (e) {
    alert(`Failed to decrypt secrets: ${e.message}`);
    cryptoMod.clearPassphrase();
    return null;
  }
}

// ----- Settings persistence -----
const SKEYS = {
  anthropic:  "agency.key.anthropic",
  openai:     "agency.key.openai",
  github:     "agency.key.github",
  supabase:   "agency.key.supabase",
  ghOwner:    "agency.cfg.ghOwner",
  supaOrg:    "agency.cfg.supaOrg",
  supaRegion: "agency.cfg.supaRegion",
  supaProxy:  "agency.cfg.supaProxy",
  agentsRepo: "agency.cfg.agentsRepo",
  stateUrl:   "agency.state.url",
  stateKey:   "agency.state.anonKey",
};

function seedFromAutoConfig() {
  const cfg = window.AGENCY_CONFIG;
  if (!cfg || typeof cfg !== "object") return false;
  let touched = false;
  const map = {
    anthropic:  SKEYS.anthropic,
    openai:     SKEYS.openai,
    github:     SKEYS.github,
    supabase:   SKEYS.supabase,
    ghOwner:    SKEYS.ghOwner,
    supaOrg:    SKEYS.supaOrg,
    supaRegion: SKEYS.supaRegion,
    supaProxy:  SKEYS.supaProxy,
    agentsRepo: SKEYS.agentsRepo,
  };
  for (const [k, storageKey] of Object.entries(map)) {
    const v = cfg[k];
    if (v && !localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, v);
      touched = true;
    }
  }
  // Optional state backend
  if (cfg.state) {
    if (cfg.state.supabaseUrl && !localStorage.getItem(SKEYS.stateUrl)) {
      localStorage.setItem(SKEYS.stateUrl, cfg.state.supabaseUrl);
      touched = true;
    }
    if (cfg.state.supabaseAnonKey && !localStorage.getItem(SKEYS.stateKey)) {
      localStorage.setItem(SKEYS.stateKey, cfg.state.supabaseAnonKey);
      touched = true;
    }
  }
  return touched;
}

function loadSettings() {
  const s = {};
  for (const k in SKEYS) s[k] = localStorage.getItem(SKEYS[k]) || "";
  if (!s.supaRegion) s.supaRegion = "us-east-1";
  // Auto-derive CORS proxy from state backend URL if not explicitly set
  if (!s.supaProxy && s.stateUrl) {
    s.supaProxy = s.stateUrl.replace(/\/+$/, "") + "/functions/v1/cors-proxy";
  }
  // Apply CORS proxy setting to supabase client
  sb.setProxyUrl(s.supaProxy);
  // Overlay decrypted secrets on top of localStorage values
  if (_decryptedSecrets) {
    for (const name of SECRET_NAMES) {
      if (_decryptedSecrets[name]) s[name] = _decryptedSecrets[name];
    }
  }
  return s;
}

// Save settings. Secret values (API keys) are encrypted and pushed to Supabase.
// Non-secret config (owner/org/region/repo/state-backend URL+anon) is in localStorage.
async function saveSettings(values, { passphrase } = {}) {
  // Split secrets from non-secrets
  const secrets = {};
  const nonSecrets = {};
  for (const [storageKey, val] of Object.entries(values)) {
    const fieldName = Object.keys(SKEYS).find((k) => SKEYS[k] === storageKey);
    if (SECRET_NAMES.includes(fieldName)) {
      if (val) secrets[fieldName] = val;
    } else {
      nonSecrets[storageKey] = val;
    }
  }
  // Persist non-secrets
  for (const [k, v] of Object.entries(nonSecrets)) {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  }
  // Encrypt + upload secrets if we have a state backend
  if (Object.keys(secrets).length > 0 && state.hasStateBackend()) {
    const pass = passphrase || await ensurePassphrase({ purpose: "encrypt your API keys for storage", verify: false });
    if (!pass) throw new Error("Passphrase required to save secrets to DB");
    await state.saveSecrets(secrets, pass);
    // Update in-memory cache
    _decryptedSecrets = { ..._decryptedSecrets, ...secrets };
    // Clear plaintext from localStorage (defense in depth)
    for (const name of SECRET_NAMES) localStorage.removeItem(SKEYS[name]);
  } else if (Object.keys(secrets).length > 0) {
    // No state backend yet — fall back to localStorage (less secure but works)
    for (const [name, val] of Object.entries(secrets)) {
      localStorage.setItem(SKEYS[name], val);
    }
  }
}

function clearSettings() {
  for (const k in SKEYS) localStorage.removeItem(SKEYS[k]);
  _decryptedSecrets = null;
  cryptoMod.clearPassphrase();
}

// ----- Detect upstream agents repo from URL -----
function detectAgentsRepo() {
  const stored = localStorage.getItem(SKEYS.agentsRepo);
  if (stored) {
    const [owner, repo] = stored.split("/");
    if (owner && repo) return { owner, repo, branch: "main" };
  }
  const host = location.host;
  const m = host.match(/^([^.]+)\.github\.io$/);
  if (m) {
    const owner = m[1];
    const path = location.pathname.split("/").filter(Boolean);
    if (path.length >= 1) return { owner, repo: path[0], branch: "main" };
  }
  return { owner: "msitarzewski", repo: "agency-agents", branch: "main" };
}

// ----- DOM helpers -----
const $ = (id) => document.getElementById(id);
const log = (level, msg) => {
  const node = $("log");
  if (!node) return;
  const ln = document.createElement("div");
  ln.className = "ln";
  const time = new Date().toLocaleTimeString();
  ln.innerHTML = `<span class="ln-time">${time}</span><span class="ln-${level}">${escapeHtml(msg)}</span>`;
  node.appendChild(ln);
  node.scrollTop = node.scrollHeight;
};
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ----- Run state -----
let currentAbort = null;
let currentRunId = null;

function setView(name) {
  for (const v of ["input", "run", "roster", "runs"]) {
    const el = document.getElementById(`view-${v}`);
    if (!el) continue;
    el.classList.toggle("hidden", v !== name);
  }
}
function setStep(step, state) {
  const li = document.querySelector(`.pipeline li[data-step="${step}"]`);
  if (!li) return;
  if (state === "active") {
    document.querySelectorAll(".pipeline li.active").forEach((x) => x.classList.remove("active"));
    li.classList.add("active");
  } else if (state === "done") {
    li.classList.remove("active");
    li.classList.add("done");
  }
}
function resetPipeline() {
  document.querySelectorAll(".pipeline li").forEach((li) => li.classList.remove("active", "done"));
}

function updateSettingsPill() {
  const s = loadSettings();
  const pill = $("settings-status");
  const btn = $("run-btn");
  const hasMin = s.anthropic && s.github;
  const fromConfig = !!window.AGENCY_CONFIG;
  const hasState = state.hasStateBackend();
  if (hasMin) {
    let txt = fromConfig ? "✅ Ready · keys auto-loaded" : "✅ Ready";
    if (!hasState) txt += " · ⚠ state DB not configured";
    pill.textContent = txt;
    pill.className = hasState ? "pill pill-ok" : "pill pill-warn";
    btn.disabled = false;
  } else {
    pill.textContent = "⚙️ Configure keys to run";
    pill.className = "pill pill-warn";
    btn.disabled = true;
  }
}

// ----- Roster view -----
function renderRoster(filter = "") {
  const reg = getRegistry();
  if (!reg) return;
  const container = $("roster-divisions");
  container.innerHTML = "";
  const grouped = agentsByDivision();
  const f = filter.trim().toLowerCase();
  const divisions = Object.keys(grouped).sort();
  for (const div of divisions) {
    const matches = grouped[div].filter((a) =>
      !f ||
      a.name.toLowerCase().includes(f) ||
      a.description.toLowerCase().includes(f) ||
      a.slug.toLowerCase().includes(f)
    );
    if (matches.length === 0) continue;
    const sec = document.createElement("div");
    sec.className = "division-section";
    sec.innerHTML = `<h3>${escapeHtml(div)} <span style="color:var(--text3);font-weight:400">· ${matches.length}</span></h3>`;
    const grid = document.createElement("div");
    grid.className = "roster-grid";
    for (const a of matches) {
      const c = document.createElement("div");
      c.className = "roster-card";
      c.innerHTML = `
        <div class="rc-head">
          <span class="agent-emoji">${escapeHtml(a.emoji || "🤖")}</span>
          <div>
            <div class="rc-name">${escapeHtml(a.name)}</div>
            <div class="agent-div">${escapeHtml(a.slug)}</div>
          </div>
        </div>
        <div class="rc-desc">${escapeHtml(a.description || "")}</div>`;
      grid.appendChild(c);
    }
    sec.appendChild(grid);
    container.appendChild(sec);
  }
}

// ----- Runs view -----
async function renderRuns() {
  const list = $("runs-list");
  list.innerHTML = `<p class="muted">Loading…</p>`;
  let runs;
  try { runs = await state.listRuns({ limit: 50 }); }
  catch (e) { list.innerHTML = `<p class="muted">Failed to load runs: ${escapeHtml(e.message)}</p>`; return; }
  list.innerHTML = "";
  if (!runs || runs.length === 0) {
    list.innerHTML = `<p class="muted">No runs yet. Submit an idea to get started.</p>`;
    return;
  }
  for (const r of runs) {
    const row = document.createElement("div");
    row.className = "run-row";
    const status = r.status || "unknown";
    const sub = [
      new Date(r.started_at || r.startedAt || Date.now()).toLocaleString(),
      `step: ${r.current_step || "?"}`,
      `status: ${status}`,
      r.supabase_ref ? "🟢 Supabase" : null,
      r.repo_url ? "🐙 GitHub" : null,
    ].filter(Boolean).join(" · ");
    const links = [];
    if (r.pages_url)     links.push(`<a href="${r.pages_url}" target="_blank" rel="noopener">🌐 Pages</a>`);
    if (r.repo_url)      links.push(`<a href="${r.repo_url}" target="_blank" rel="noopener">📂 Repo</a>`);
    if (r.supabase_url)  links.push(`<a href="${r.supabase_url}" target="_blank" rel="noopener">🟢 Supabase</a>`);

    const actions = [];
    // Resume only works for runs that have a complete plan persisted (state-driven era).
    const hasFullPlan = r.plan && Array.isArray(r.plan.phases) && r.plan.phases.length > 0 && Array.isArray(r.plan.team);
    const isLegacy = !!r.legacy;
    if (!isLegacy && hasFullPlan && (status === "failed" || (status !== "shipped" && r.current_step !== "done"))) {
      actions.push(`<button class="ghost-sm" data-action="resume" data-id="${r.id}" type="button">⟳ Resume</button>`);
    }
    if (status === "shipped" && hasFullPlan) {
      actions.push(`<button class="ghost-sm" data-action="cr" data-id="${r.id}" type="button">✎ Request change</button>`);
    }
    actions.push(`<button class="ghost-sm" data-action="details" data-id="${r.id}" type="button">Details</button>`);

    const title = r.plan?.projectTitle || r.plan?.projectName || (r.idea ? r.idea.slice(0, 60) + (r.idea.length > 60 ? "…" : "") : "Untitled");
    const errLine = r.error ? `<div class="rr-err">⚠ ${escapeHtml(r.error.slice(0, 200))}</div>` : "";

    row.innerHTML = `
      <div>
        <div class="rr-title">${escapeHtml(title)}</div>
        <div class="rr-sub">${escapeHtml(sub)}</div>
        ${errLine}
      </div>
      <div class="rr-links">${links.join("")} ${actions.join(" ")}</div>`;
    list.appendChild(row);
  }
  // Wire up action buttons
  list.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => onRunAction(btn.dataset.action, btn.dataset.id));
  });
}

async function onRunAction(action, id) {
  if (action === "resume") {
    if (!confirm("Resume this run? Completed agents will be skipped; failed/pending agents and the integrator will retry.")) return;
    runPipeline({ runId: id, mode: "resume" });
  } else if (action === "cr") {
    await openChangeRequestPrompt(id);
  } else if (action === "details") {
    await openRunDetails(id);
  }
}

async function openChangeRequestPrompt(runId) {
  const run = await state.getRun(runId);
  if (!run || !run.plan) { alert("Run not found or has no plan."); return; }
  const slugs = (run.plan.team || []).map((m) => m.slug);
  const list = slugs.map((s) => `  - ${s}`).join("\n");
  const chosen = prompt(
    `Which agents should re-run for this CR? Comma-separated slugs.\n\nAvailable:\n${list}`,
    slugs.slice(0, 1).join(",")
  );
  if (!chosen) return;
  const targetSlugs = chosen.split(",").map((s) => s.trim()).filter(Boolean);
  if (targetSlugs.length === 0) return;
  const change = prompt(`Describe the change. This will become the new task for: ${targetSlugs.join(", ")}`, "");
  if (!change) return;
  // Build new_tasks map: same change text for each selected agent. The integrator
  // will reconcile against existing files in the repo.
  const newTasks = {};
  for (const s of targetSlugs) newTasks[s] = change;
  const cr = await state.createChangeRequest({
    runId,
    description: change,
    agentSlugs: targetSlugs,
    newTasks,
  });
  runPipeline({ runId, mode: "cr", changeRequest: cr });
}

async function openRunDetails(id) {
  const run = await state.getRun(id);
  if (!run) { alert("Run not found."); return; }
  const outs = await state.getAgentOutputs(id);
  const lines = [];
  lines.push(`# ${run.plan?.projectTitle || run.idea}`);
  lines.push(`Status: ${run.status} · step: ${run.current_step}`);
  if (run.repo_url) lines.push(`Repo: ${run.repo_url}`);
  if (run.supabase_url) lines.push(`Supabase: ${run.supabase_url}`);
  if (run.pages_url) lines.push(`Pages: ${run.pages_url}`);
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push("");
  lines.push(`Agents (${outs.length}):`);
  for (const a of outs) {
    lines.push(`  ${a.status === "done" ? "✓" : a.status === "failed" ? "✗" : "·"} ${a.slug} (phase ${a.phase}) — ${a.status}${a.error ? " — " + a.error.slice(0, 100) : ""}`);
  }
  alert(lines.join("\n"));
}

// ----- Board (agent cards) -----
function renderBoard(plan, statusMap) {
  const board = $("board");
  board.innerHTML = "";
  for (const m of plan.team) {
    const a = getAgentBySlug(m.slug);
    const st = (statusMap && statusMap.get(m.slug)) || "queued";
    const card = document.createElement("div");
    card.className = `agent-card ${st}`;
    card.id = `card-${m.slug}`;
    card.innerHTML = `
      <span class="agent-status status-${st}" data-status>${st.toUpperCase()}</span>
      <header>
        <span class="agent-emoji">${escapeHtml(a?.emoji || "🤖")}</span>
        <div>
          <div class="agent-name">${escapeHtml(a?.name || m.slug)}</div>
          <div class="agent-div">${escapeHtml(a?.division || "")} · phase ${m.phase || 1}</div>
        </div>
      </header>
      <div class="agent-task">${escapeHtml(m.task || "")}</div>
      <div class="agent-meta">
        <span>${escapeHtml((m.model || "auto"))}</span>
        ${m.dependsOn?.length ? `<span>deps: ${m.dependsOn.length}</span>` : ""}
      </div>`;
    board.appendChild(card);
  }
}
function updateCard(slug, status, extra = {}) {
  const card = document.getElementById(`card-${slug}`);
  if (!card) return;
  card.classList.remove("queued", "running", "done", "failed");
  card.classList.add(status);
  const badge = card.querySelector("[data-status]");
  if (badge) {
    badge.className = `agent-status status-${status}`;
    badge.textContent = status.toUpperCase();
  }
  if (extra.provider) {
    const meta = card.querySelector(".agent-meta span:first-child");
    if (meta) meta.textContent = extra.provider;
  }
}

// ============================================================
// THE PIPELINE — state-driven, resumable, supports CR
// ============================================================
async function runPipeline({ idea, runId, mode = "fresh", changeRequest = null }) {
  const settings = loadSettings();
  if (!settings.anthropic) { alert("Add your Anthropic API key in Settings first."); return; }
  if (!settings.github)    { alert("Add your GitHub personal access token in Settings first."); return; }

  setView("run");
  resetPipeline();
  $("result-panel").classList.add("hidden");
  $("log").innerHTML = "";
  $("board").innerHTML = "";
  $("run-tech").innerHTML = "";

  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  // ---- Load or create the run record ----
  let run;
  if (mode === "fresh") {
    run = await state.createRun({ idea });
    $("run-title").textContent = "Planning…";
    $("run-started").textContent = new Date().toLocaleString();
    log("step", `New run ${run.id.slice(0, 8)}…`);
  } else {
    run = await state.getRun(runId);
    if (!run) { alert("Run not found."); return; }
    $("run-title").textContent = run.plan?.projectTitle || run.plan?.projectName || "Resuming…";
    $("run-started").textContent = new Date(run.started_at).toLocaleString();
    log("step", `${mode === "cr" ? "Applying change request" : "Resuming"} on run ${run.id.slice(0, 8)}…`);
    if (mode === "cr") log("info", `Change: ${changeRequest?.description || "(no description)"}`);
  }
  currentRunId = run.id;

  try {
    // ============ 1. PLAN ============
    setStep("plan", "active");
    let plan = run.plan;
    if (!plan) {
      log("step", "Asking the orchestrator to assemble a team…");
      plan = await retryAsync(
        () => planTeam({ apiKey: settings.anthropic, idea: run.idea, signal }),
        { retries: 2, onAttempt: ({ attempt, error, willRetry }) => {
          if (error && willRetry) log("warn", `Planner attempt ${attempt} failed: ${error.message} — retrying`);
        }},
      );
      await state.updateRun(run.id, { plan, status: "provisioning", current_step: "provision" });
      log("ok", `Plan: ${plan.projectTitle} — ${plan.team.length} agents across ${plan.phases.length} phase(s).`);
    } else {
      log("info", `Reusing plan: ${plan.projectTitle} — ${plan.team.length} agents`);
    }
    log("info", `Stack: ${(plan.techStack || []).join(", ")}`);
    log("info", `Needs database: ${plan.needsDatabase ? "yes" : "no"}`);
    $("run-title").textContent = plan.projectTitle || plan.projectName;
    $("run-tech").innerHTML = (plan.techStack || []).map((t) => `<span class="tech-chip">${escapeHtml(t)}</span>`).join("");

    // Preload prior outputs into a Map for the board + runner
    const priorAgentRows = await state.getAgentOutputs(run.id);
    const priorOutputs = new Map();
    const initStatuses = new Map();
    for (const row of priorAgentRows) {
      if (row.status === "done") priorOutputs.set(row.slug, row);
      initStatuses.set(row.slug, row.status);
    }
    renderBoard(plan, initStatuses);
    setStep("plan", "done");

    // ============ 2. PROVISION ============
    setStep("provision", "active");
    let repoFullName = run.repo_full_name;
    let repoUrl = run.repo_url;
    let repoDefaultBranch = run.repo_default_branch || "main";

    if (!repoFullName) {
      log("step", "Provisioning new GitHub repository…");
      const viewer = await retryAsync(() => gh.getViewer(settings.github), { retries: 2 });
      log("info", `Authenticated as github.com/${viewer.login}`);
      const repoName = gh.slugifyRepoName(plan.projectName) + "-" + Date.now().toString(36).slice(-4);
      const ownerInput = settings.ghOwner && settings.ghOwner.trim() ? settings.ghOwner.trim() : null;
      const repo = await retryAsync(
        () => gh.createRepo(settings.github, {
          name: repoName,
          description: plan.summary?.slice(0, 350) || "Built by The Agency orchestrator",
          isPrivate: false,
          owner: ownerInput,
        }),
        { retries: 2 },
      );
      repoFullName = repo.full_name;
      repoUrl = repo.html_url;
      repoDefaultBranch = repo.default_branch || "main";
      await state.updateRun(run.id, {
        repo_url: repoUrl,
        repo_full_name: repoFullName,
        repo_default_branch: repoDefaultBranch,
      });
      log("ok", `Repo created: ${repoUrl}`);
    } else {
      log("info", `Reusing repo: ${repoUrl}`);
    }

    let supabaseInfo = null;
    if (plan.needsDatabase && settings.supabase) {
      if (run.supabase_ref) {
        supabaseInfo = {
          ref: run.supabase_ref,
          url: run.supabase_url,
          anonKey: run.supabase_anon_key,
          dbPassword: run.supabase_db_password,
        };
        log("info", `Reusing Supabase: ${supabaseInfo.url}`);
      } else if (!settings.supaOrg) {
        log("warn", "Supabase token present but no organization ID configured — skipping Supabase provision.");
      } else {
        log("step", "Creating new Supabase project (this can take 60–120s)…");
        const dbPass = sb.genDbPassword();
        const supaProj = await retryAsync(
          () => sb.createProject(settings.supabase, {
            name: gh.slugifyRepoName(plan.projectName),
            organizationId: settings.supaOrg,
            region: settings.supaRegion || "us-east-1",
            dbPassword: dbPass,
          }),
          { retries: 2 },
        );
        log("info", `Supabase project ref=${supaProj.id || supaProj.ref}, waiting for ACTIVE_HEALTHY…`);
        const ref = supaProj.id || supaProj.ref;
        await sb.waitForProjectActive(settings.supabase, ref, {
          onTick: (status) => log("info", `  status: ${status}`),
        });
        const keys = await sb.getApiKeys(settings.supabase, ref).catch(() => []);
        const anonKey = (Array.isArray(keys) ? keys.find((k) => k.name === "anon") : null)?.api_key || "";
        supabaseInfo = {
          ref,
          url: sb.projectUrlFromRef(ref),
          anonKey,
          dbPassword: dbPass,
        };
        await state.updateRun(run.id, {
          supabase_ref: ref,
          supabase_url: supabaseInfo.url,
          supabase_anon_key: anonKey,
          supabase_db_password: dbPass,
        });
        log("ok", `Supabase ready: ${supabaseInfo.url}`);
      }
    } else if (plan.needsDatabase && !settings.supabase) {
      log("warn", "Plan calls for a database but Supabase token is missing.");
    }
    await state.updateRun(run.id, { status: "running", current_step: "work" });
    setStep("provision", "done");

    // ============ 3. WORK ============
    setStep("work", "active");
    log("step", "Running specialist agents…");
    const agentsRepo = detectAgentsRepo();
    log("info", `Fetching agent personas from ${agentsRepo.owner}/${agentsRepo.repo}@${agentsRepo.branch}`);

    // For CR mode, apply new tasks to the plan and force re-run those agents.
    let effectivePlan = plan;
    const forceRerunSlugs = new Set();
    if (mode === "cr" && changeRequest) {
      effectivePlan = JSON.parse(JSON.stringify(plan));   // deep clone
      for (const m of effectivePlan.team) {
        if (changeRequest.new_tasks && changeRequest.new_tasks[m.slug]) {
          m.task = `${m.task}\n\n[CHANGE REQUEST] ${changeRequest.new_tasks[m.slug]}`;
          forceRerunSlugs.add(m.slug);
        }
      }
      log("info", `CR: forcing re-run of ${forceRerunSlugs.size} agent(s)`);
    }

    const runner = createRunner({
      plan: effectivePlan,
      keys: { anthropic: settings.anthropic, openai: settings.openai },
      agentsRepo,
      signal,
      priorOutputs,
      forceRerunSlugs,
      onAgentDone: async (record) => {
        try {
          await state.saveAgentOutput({
            runId: run.id,
            slug: record.slug,
            name: record.name,
            division: record.division,
            provider: record.provider,
            phase: record.phase,
            status: record.status,
            output: record.output || null,
            error: record.error || null,
            usage: record.usage || null,
          });
        } catch (e) { console.warn("state.saveAgentOutput failed:", e); }
      },
      onEvent: (e) => {
        if (e.type === "status") updateCard(e.slug, e.status, e);
        else if (e.type === "log") log(e.level, e.msg);
        else if (e.type === "phase") log("step", `Phase ${e.phase}: ${e.label} — running ${e.agents.length} agent(s) in parallel.`);
      },
    });
    const outputs = await runner.run();
    setStep("work", "done");
    log("ok", `All agents finished. ${outputs.length}/${effectivePlan.team.length} succeeded.`);
    await state.updateRun(run.id, { status: "integrating", current_step: "integrate" });

    if (outputs.length === 0) throw new Error("No agents produced output — aborting.");

    // ============ 4. INTEGRATE ============
    setStep("integrate", "active");
    log("step", "Asking integrator to assemble the file tree…");
    let attemptNum = 0;
    const integrated = await integrateOutputs({
      apiKey: settings.anthropic,
      plan: effectivePlan,
      outputs,
      hasSupabase: !!supabaseInfo,
      signal,
      onAttempt: async ({ attempt, raw, parsed, error }) => {
        attemptNum = attempt;
        try {
          await state.saveIntegratorOutput({
            runId: run.id,
            raw: raw || null,
            parsed: parsed || null,
            error: error || null,
            attempt,
          });
        } catch {}
        if (error) log("warn", `Integrator attempt ${attempt} failed: ${error}`);
        else if (raw && !parsed) log("info", `Integrator attempt ${attempt}: raw response captured (${raw.length.toLocaleString()} chars), parsing…`);
      },
    });
    log("ok", `Integrator produced ${integrated.files.length} file(s).`);
    setStep("integrate", "done");
    await state.updateRun(run.id, {
      integrator_files: integrated,
      integrator_raw: integrated._raw || null,
      status: "publishing",
      current_step: "publish",
    });

    // ============ 5. PUBLISH ============
    setStep("publish", "active");

    let files = integrated.files.slice();
    // Auto-inject .env / env.js for static sites with Supabase
    if (supabaseInfo) {
      const hasEnv = files.find((f) => /^\.env(\.|$)/.test(f.path));
      if (!hasEnv) {
        files.push({
          path: ".env.example",
          content: `SUPABASE_URL=${supabaseInfo.url}\nSUPABASE_ANON_KEY=${supabaseInfo.anonKey}\n`,
        });
      }
      const hasEnvJs = files.find((f) => f.path === "env.js" || f.path === "config.js");
      if (!hasEnvJs) {
        files.push({
          path: "env.js",
          content: `// Auto-generated by The Agency orchestrator.\nwindow.ENV = window.ENV || {};\nwindow.ENV.SUPABASE_URL = "${supabaseInfo.url}";\nwindow.ENV.SUPABASE_ANON_KEY = "${supabaseInfo.anonKey}";\n`,
        });
      }
    }
    // README credit
    const readmeIdx = files.findIndex((f) => f.path.toLowerCase() === "readme.md");
    const credit = `\n\n---\n\n_Built by [The Agency](https://github.com/msitarzewski/agency-agents) — orchestrator run on ${new Date().toISOString()}._\n`;
    if (readmeIdx >= 0 && !files[readmeIdx].content.includes("The Agency")) {
      files[readmeIdx].content += credit;
    } else if (readmeIdx === -1) {
      files.push({
        path: "README.md",
        content: `# ${plan.projectTitle}\n\n${plan.summary}\n${credit}`,
      });
    }

    const commitMsg = mode === "cr"
      ? `🎭 CR: ${changeRequest?.description?.slice(0, 80) || "change request"}\n\nAgents re-run: ${[...forceRerunSlugs].join(", ")}`
      : `🎭 Initial commit by The Agency orchestrator\n\n${plan.team.length} agents · ${plan.phases.length} phases`;

    log("step", `Pushing ${files.length} files to ${repoFullName}…`);
    const [owner, repoName] = repoFullName.split("/");
    await retryAsync(
      () => gh.pushFilesAsCommit(settings.github, {
        owner,
        repo: repoName,
        branch: repoDefaultBranch,
        message: commitMsg,
        files,
      }),
      { retries: 3, baseDelayMs: 1500 },
    );
    log("ok", "Files pushed.");

    // Apply DB schema if present
    if (supabaseInfo) {
      const schema = files.find((f) => /^db\/schema\.sql$/i.test(f.path));
      if (schema && schema.content.trim()) {
        log("step", "Applying db/schema.sql to Supabase…");
        try {
          await sb.runSQL(settings.supabase, supabaseInfo.ref, schema.content);
          log("ok", "Schema applied.");
        } catch (e) {
          log("warn", `Schema apply failed: ${e.message}`);
        }
      }
    }

    // Pages
    let pagesUrl = run.pages_url || null;
    if (plan.githubPagesReady && !pagesUrl) {
      log("step", "Enabling GitHub Pages…");
      try {
        const pages = await gh.enablePages(settings.github, {
          owner, repo: repoName, branch: repoDefaultBranch, path: "/",
        });
        pagesUrl = pages.html_url || `https://${owner}.github.io/${repoName}/`;
        await state.updateRun(run.id, { pages_url: pagesUrl });
        log("ok", `Pages enabled: ${pagesUrl}`);
      } catch (e) {
        log("warn", `Could not enable Pages automatically: ${e.message}`);
      }
    }
    setStep("publish", "done");

    // ============ 6. DONE ============
    setStep("done", "active");
    setStep("done", "done");
    await state.updateRun(run.id, { status: "shipped", current_step: "done", error: null });

    if (mode === "cr" && changeRequest) {
      await state.updateChangeRequest(changeRequest.id, { status: "completed", completed_at: new Date().toISOString() });
    }

    showResult({
      plan,
      repoFullName,
      repoUrl,
      pagesUrl,
      supabaseInfo,
      files,
      outputs,
      mode,
    });
    log("ok", mode === "cr" ? "🎉 CR shipped." : "🎉 Shipped.");
  } catch (err) {
    if (err.message === "aborted") {
      log("warn", "Run aborted by user.");
      await state.updateRun(run.id, { status: "failed", error: "aborted" });
    } else {
      log("err", `Run failed: ${err.message}`);
      console.error(err);
      await state.updateRun(run.id, { status: "failed", error: err.message });
      if (mode === "cr" && changeRequest) {
        await state.updateChangeRequest(changeRequest.id, { status: "failed", error: err.message });
      }
    }
  } finally {
    currentAbort = null;
  }
}

function showResult({ plan, repoFullName, repoUrl, pagesUrl, supabaseInfo, files, outputs, mode }) {
  const panel = $("result-panel");
  const body = $("result-body");
  const links = [];
  links.push(`<div class="result-card"><h4>GitHub repo</h4><a href="${repoUrl}" target="_blank" rel="noopener">${repoFullName}</a></div>`);
  if (pagesUrl) links.push(`<div class="result-card"><h4>Live site</h4><a href="${pagesUrl}" target="_blank" rel="noopener">${pagesUrl}</a><br><small class="muted">First deploy can take ~60s.</small></div>`);
  if (supabaseInfo) links.push(`<div class="result-card"><h4>Supabase</h4><a href="https://supabase.com/dashboard/project/${supabaseInfo.ref}" target="_blank" rel="noopener">Dashboard</a><br><small class="muted">${supabaseInfo.url}</small></div>`);
  links.push(`<div class="result-card"><h4>Team</h4>${plan.team.length} specialists, ${outputs.length} delivered · ${files.length} files</div>`);
  const heading = mode === "cr" ? "🛠 Change request shipped" : "🎉 Shipped";
  panel.querySelector("h3").textContent = heading;
  body.innerHTML = `
    <p>${escapeHtml(plan.summary || "")}</p>
    <div class="result-grid">${links.join("")}</div>
    <details class="result-files"><summary>📁 ${files.length} files committed</summary>
      <ul>${files.map((f) => `<li>${escapeHtml(f.path)} <span class="muted">· ${f.content.length.toLocaleString()} chars</span></li>`).join("")}</ul>
    </details>`;
  panel.classList.remove("hidden");
}

// ----- Settings modal -----
function openSettings() {
  const s = loadSettings();
  // Always populate state backend fields (non-secret)
  if ($("cfg-state-url"))     $("cfg-state-url").value     = s.stateUrl;
  if ($("cfg-state-anonkey")) $("cfg-state-anonkey").value = s.stateKey;
  // Clear passphrase field and hide protected section
  $("cfg-passphrase").value = "";
  $("settings-protected").classList.add("hidden");
  $("btn-unlock-settings").classList.remove("hidden");
  $("unlock-error").classList.add("hidden");
  // Clear all sensitive fields so nothing leaks before unlock
  $("key-anthropic").value = "";
  $("key-openai").value = "";
  $("key-github").value = "";
  $("key-supabase").value = "";
  $("cfg-gh-owner").value = "";
  $("cfg-supabase-org").value = "";
  $("cfg-supabase-region").value = "us-east-1";
  $("cfg-agents-repo").value = "";
  if ($("cfg-supabase-proxy")) $("cfg-supabase-proxy").value = "";
  $("modal-settings").classList.remove("hidden");
}

async function unlockSettings() {
  const passInput = $("cfg-passphrase");
  const passphrase = passInput ? passInput.value : "";
  if (!passphrase) {
    $("unlock-error").textContent = "Enter a passphrase to unlock settings.";
    $("unlock-error").classList.remove("hidden");
    return;
  }
  // Verify against canary if one exists
  if (state.hasStateBackend()) {
    try {
      const canary = await state.getCanarySecret();
      if (canary) {
        const ok = await cryptoMod.verifyPassphrase(canary, passphrase);
        if (!ok) {
          $("unlock-error").textContent = "Wrong passphrase. Try again.";
          $("unlock-error").classList.remove("hidden");
          return;
        }
      }
    } catch {}
  }
  // Cache the passphrase and decrypt secrets
  cryptoMod.setPassphrase(passphrase);
  if (state.hasStateBackend()) {
    try {
      _decryptedSecrets = await state.loadSecrets(passphrase);
    } catch (e) {
      $("unlock-error").textContent = `Decryption failed: ${e.message}`;
      $("unlock-error").classList.remove("hidden");
      cryptoMod.clearPassphrase();
      return;
    }
  }
  // Now populate the fields
  const s = loadSettings();
  $("key-anthropic").value = s.anthropic;
  $("key-openai").value = s.openai;
  $("key-github").value = s.github;
  $("key-supabase").value = s.supabase;
  $("cfg-gh-owner").value = s.ghOwner;
  $("cfg-supabase-org").value = s.supaOrg;
  $("cfg-supabase-region").value = s.supaRegion || "us-east-1";
  $("cfg-agents-repo").value = s.agentsRepo;
  if ($("cfg-supabase-proxy")) $("cfg-supabase-proxy").value = s.supaProxy;
  // Reveal the protected section and hide the unlock button
  $("settings-protected").classList.remove("hidden");
  $("btn-unlock-settings").classList.add("hidden");
  $("unlock-error").classList.add("hidden");
}

function closeSettings() {
  // Clear all sensitive fields on close
  $("key-anthropic").value = "";
  $("key-openai").value = "";
  $("key-github").value = "";
  $("key-supabase").value = "";
  $("cfg-passphrase").value = "";
  $("cfg-gh-owner").value = "";
  $("cfg-supabase-org").value = "";
  if ($("cfg-supabase-proxy")) $("cfg-supabase-proxy").value = "";
  $("cfg-agents-repo").value = "";
  // Re-hide protected section
  $("settings-protected").classList.add("hidden");
  $("btn-unlock-settings").classList.remove("hidden");
  $("unlock-error").classList.add("hidden");
  $("modal-settings").classList.add("hidden");
}
async function applySettings() {
  const passInput = $("cfg-passphrase");
  const passphrase = passInput ? passInput.value : "";
  try {
    await saveSettings({
      [SKEYS.anthropic]:  $("key-anthropic").value.trim(),
      [SKEYS.openai]:     $("key-openai").value.trim(),
      [SKEYS.github]:     $("key-github").value.trim(),
      [SKEYS.supabase]:   $("key-supabase").value.trim(),
      [SKEYS.ghOwner]:    $("cfg-gh-owner").value.trim(),
      [SKEYS.supaOrg]:    $("cfg-supabase-org").value.trim(),
      [SKEYS.supaRegion]: $("cfg-supabase-region").value,
      [SKEYS.supaProxy]:  $("cfg-supabase-proxy") ? $("cfg-supabase-proxy").value.trim() : "",
      [SKEYS.agentsRepo]: $("cfg-agents-repo").value.trim(),
      [SKEYS.stateUrl]:   $("cfg-state-url")     ? $("cfg-state-url").value.trim()     : "",
      [SKEYS.stateKey]:   $("cfg-state-anonkey") ? $("cfg-state-anonkey").value.trim() : "",
    }, { passphrase: passphrase || undefined });
    // Wipe the passphrase field after save
    if (passInput) passInput.value = "";
    updateSettingsPill();
    closeSettings();
  } catch (e) {
    alert(`Settings save failed: ${e.message}`);
  }
}

async function loadSupabaseOrgs() {
  const token = $("key-supabase").value.trim();
  if (!token) { alert("Enter your Supabase token first."); return; }
  try {
    const orgs = await sb.listOrganizations(token);
    if (!Array.isArray(orgs) || orgs.length === 0) { alert("No Supabase orgs found for this token."); return; }
    const list = orgs.map((o) => `${o.name} → ${o.id}`).join("\n");
    const chosen = prompt(`Found ${orgs.length} org(s):\n\n${list}\n\nPaste the org ID to use:`, orgs[0].id);
    if (chosen) $("cfg-supabase-org").value = chosen.trim();
  } catch (e) {
    alert(`Failed to load orgs: ${e.message}`);
  }
}

// ----- Init -----
async function init() {
  seedFromAutoConfig();
  state.migrateLegacyRuns();

  try {
    const reg = await loadRegistry();
    $("agent-count").textContent = reg.totalAgents;
    $("division-count").textContent = reg.divisions.length;
    renderRoster();
  } catch (e) {
    log("err", `Failed to load agent registry: ${e.message}`);
  }

  // If state backend is configured and has stored secrets, prompt for passphrase
  // and decrypt. Don't block init on failure — settings UI can still be used.
  if (state.hasStateBackend()) {
    try {
      const names = await state.listSecretNames();
      if (names && names.length > 0) {
        await loadEncryptedSecrets();
      }
    } catch (e) {
      console.warn("[init] could not check for encrypted secrets:", e.message);
    }
  }
  updateSettingsPill();

  $("idea-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const idea = $("idea").value.trim();
    if (!idea) return;
    runPipeline({ idea, mode: "fresh" });
  });

  document.querySelectorAll(".example-chip").forEach((b) => {
    b.addEventListener("click", () => { $("idea").value = b.dataset.example; $("idea").focus(); });
  });

  $("nav-roster").addEventListener("click", () => { setView("roster"); renderRoster($("roster-search").value); });
  $("nav-runs").addEventListener("click", () => { setView("runs"); renderRuns(); });
  $("nav-settings").addEventListener("click", openSettings);

  $("settings-save").addEventListener("click", applySettings);
  $("btn-unlock-settings").addEventListener("click", unlockSettings);
  $("cfg-passphrase").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); unlockSettings(); }
  });
  $("settings-clear").addEventListener("click", () => {
    if (confirm("Clear all stored keys and settings from this browser?")) {
      clearSettings();
      updateSettingsPill();
      closeSettings();
    }
  });
  $("btn-load-supa-orgs").addEventListener("click", loadSupabaseOrgs);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSettings));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });

  $("run-cancel").addEventListener("click", () => {
    if (currentAbort) currentAbort.abort();
  });

  $("roster-search").addEventListener("input", (e) => renderRoster(e.target.value));

  $("log-clear").addEventListener("click", () => { $("log").innerHTML = ""; });

  if (!loadSettings().anthropic && !window.AGENCY_CONFIG) {
    setTimeout(() => {
      if (!loadSettings().anthropic) openSettings();
    }, 800);
  }
}

function safeInit() {
  Promise.resolve().then(init).catch((err) => {
    console.error("[Agency] init failed:", err);
    const pill = document.getElementById("settings-status");
    if (pill) {
      pill.textContent = "❌ init error — see console";
      pill.className = "pill pill-warn";
    }
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", safeInit);
} else {
  safeInit();
}
