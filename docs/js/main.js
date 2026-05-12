// Main controller — wires UI events to the orchestrator, runner, and publishers.

import { loadRegistry, getRegistry, agentsByDivision, getAgentBySlug } from "./agents.js";
import { planTeam, integrateOutputs } from "./orchestrator.js";
import { createRunner } from "./runner.js";
import * as gh from "./github.js";
import * as sb from "./supabase.js";

// ----- Settings persistence -----
const SKEYS = {
  anthropic: "agency.key.anthropic",
  openai:    "agency.key.openai",
  github:    "agency.key.github",
  supabase:  "agency.key.supabase",
  ghOwner:   "agency.cfg.ghOwner",
  supaOrg:   "agency.cfg.supaOrg",
  supaRegion:"agency.cfg.supaRegion",
  agentsRepo:"agency.cfg.agentsRepo",
  runs:      "agency.runs",
};

// Seed localStorage from window.AGENCY_CONFIG (defined in /config.js) on first
// load — only fills slots that are empty so user-saved values always win.
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
    agentsRepo: SKEYS.agentsRepo,
  };
  for (const [k, storageKey] of Object.entries(map)) {
    const v = cfg[k];
    if (v && !localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, v);
      touched = true;
    }
  }
  return touched;
}

function loadSettings() {
  const s = {};
  for (const k in SKEYS) s[k] = localStorage.getItem(SKEYS[k]) || "";
  if (!s.supaRegion) s.supaRegion = "us-east-1";
  return s;
}
function saveSettings(values) {
  for (const k in values) {
    if (values[k]) localStorage.setItem(SKEYS[k], values[k]);
    else localStorage.removeItem(SKEYS[k]);
  }
}
function clearSettings() {
  for (const k in SKEYS) localStorage.removeItem(SKEYS[k]);
}

// ----- Detect upstream agents repo from URL -----
function detectAgentsRepo() {
  // e.g. https://omar.github.io/ai-agents-library/   →  omar/ai-agents-library
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
  // Local default — falls back to upstream
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
  if (hasMin) {
    pill.textContent = fromConfig ? "✅ Ready · keys auto-loaded" : "✅ Ready";
    pill.className = "pill pill-ok";
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

// ----- Run history -----
function saveRun(record) {
  const all = JSON.parse(localStorage.getItem(SKEYS.runs) || "[]");
  all.unshift(record);
  while (all.length > 25) all.pop();
  localStorage.setItem(SKEYS.runs, JSON.stringify(all));
}
function listRuns() {
  try { return JSON.parse(localStorage.getItem(SKEYS.runs) || "[]"); }
  catch { return []; }
}
function renderRuns() {
  const list = $("runs-list");
  list.innerHTML = "";
  const all = listRuns();
  if (all.length === 0) {
    list.innerHTML = `<p class="muted">No runs yet. Submit an idea to get started.</p>`;
    return;
  }
  for (const r of all) {
    const row = document.createElement("div");
    row.className = "run-row";
    const sub = [
      new Date(r.startedAt).toLocaleString(),
      `${r.team?.length || 0} agents`,
      r.supabaseRef ? "🟢 Supabase" : null,
      r.repoUrl ? "🐙 GitHub" : null,
    ].filter(Boolean).join(" · ");
    const links = [];
    if (r.pagesUrl)    links.push(`<a href="${r.pagesUrl}" target="_blank" rel="noopener">🌐 Pages</a>`);
    if (r.repoUrl)     links.push(`<a href="${r.repoUrl}" target="_blank" rel="noopener">📂 Repo</a>`);
    if (r.supabaseUrl) links.push(`<a href="${r.supabaseUrl}" target="_blank" rel="noopener">🟢 Supabase</a>`);
    row.innerHTML = `
      <div>
        <div class="rr-title">${escapeHtml(r.projectTitle || r.projectName || "Untitled")}</div>
        <div class="rr-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="rr-links">${links.join("")}</div>`;
    list.appendChild(row);
  }
}

// ----- Board (agent cards) -----
function renderBoard(plan) {
  const board = $("board");
  board.innerHTML = "";
  for (const m of plan.team) {
    const a = getAgentBySlug(m.slug);
    const card = document.createElement("div");
    card.className = "agent-card queued";
    card.id = `card-${m.slug}`;
    card.innerHTML = `
      <span class="agent-status status-queued" data-status>QUEUED</span>
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
      </div>
    `;
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

// ----- The big one: run -----
async function runOrchestration(idea) {
  const settings = loadSettings();
  if (!settings.anthropic) { alert("Add your Anthropic API key in Settings first."); return; }
  if (!settings.github)    { alert("Add your GitHub personal access token in Settings first."); return; }

  setView("run");
  resetPipeline();
  $("result-panel").classList.add("hidden");
  $("log").innerHTML = "";
  $("board").innerHTML = "";
  $("run-tech").innerHTML = "";
  $("run-title").textContent = "Planning…";
  $("run-started").textContent = new Date().toLocaleString();

  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  const runRecord = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    idea,
    team: [],
  };

  try {
    // 1 — Plan
    setStep("plan", "active");
    log("step", "Asking the orchestrator to assemble a team…");
    const plan = await planTeam({ apiKey: settings.anthropic, idea, signal });
    log("ok", `Plan: ${plan.projectTitle} — ${plan.team.length} agents across ${plan.phases.length} phase(s).`);
    log("info", `Stack: ${(plan.techStack || []).join(", ")}`);
    log("info", `Needs database: ${plan.needsDatabase ? "yes" : "no"}`);

    $("run-title").textContent = plan.projectTitle || plan.projectName;
    $("run-tech").innerHTML = (plan.techStack || []).map((t) => `<span class="tech-chip">${escapeHtml(t)}</span>`).join("");
    renderBoard(plan);
    setStep("plan", "done");

    runRecord.projectName = plan.projectName;
    runRecord.projectTitle = plan.projectTitle;
    runRecord.team = plan.team.map((m) => m.slug);

    // 2 — Provision (GitHub repo + optional Supabase)
    setStep("provision", "active");
    log("step", "Provisioning new GitHub repository…");

    const viewer = await gh.getViewer(settings.github);
    log("info", `Authenticated as github.com/${viewer.login}`);
    const repoName = gh.slugifyRepoName(plan.projectName) + "-" + Date.now().toString(36).slice(-4);
    const ownerInput = settings.ghOwner && settings.ghOwner.trim() ? settings.ghOwner.trim() : null;
    const repo = await gh.createRepo(settings.github, {
      name: repoName,
      description: plan.summary?.slice(0, 350) || "Built by The Agency orchestrator",
      isPrivate: false,
      owner: ownerInput,
    });
    log("ok", `Repo created: ${repo.html_url}`);
    runRecord.repoUrl = repo.html_url;
    runRecord.repoFullName = repo.full_name;

    let supabaseInfo = null;
    if (plan.needsDatabase && settings.supabase) {
      if (!settings.supaOrg) {
        log("warn", "Supabase token present but no organization ID configured — skipping Supabase provision. Set one in Settings.");
      } else {
        log("step", "Creating new Supabase project (this can take 60–120s)…");
        const dbPass = sb.genDbPassword();
        const supaProj = await sb.createProject(settings.supabase, {
          name: gh.slugifyRepoName(plan.projectName),
          organizationId: settings.supaOrg,
          region: settings.supaRegion || "us-east-1",
          dbPassword: dbPass,
        });
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
        runRecord.supabaseRef = ref;
        runRecord.supabaseUrl = supabaseInfo.url;
        log("ok", `Supabase ready: ${supabaseInfo.url}`);
      }
    } else if (plan.needsDatabase && !settings.supabase) {
      log("warn", "Plan calls for a database but Supabase token is missing — code will reference env vars only.");
    }
    setStep("provision", "done");

    // 3 — Worker agents
    setStep("work", "active");
    log("step", "Running specialist agents…");
    const agentsRepo = detectAgentsRepo();
    log("info", `Fetching agent personas from ${agentsRepo.owner}/${agentsRepo.repo}@${agentsRepo.branch}`);
    const runner = createRunner({
      plan,
      keys: { anthropic: settings.anthropic, openai: settings.openai },
      agentsRepo,
      signal,
      onEvent: (e) => {
        if (e.type === "status") updateCard(e.slug, e.status, e);
        else if (e.type === "log") log(e.level, e.msg);
        else if (e.type === "phase") log("step", `Phase ${e.phase}: ${e.label} — running ${e.agents.length} agent(s) in parallel.`);
      },
    });
    const outputs = await runner.run();
    setStep("work", "done");
    log("ok", `All agents finished. ${outputs.length}/${plan.team.length} succeeded.`);

    if (outputs.length === 0) throw new Error("No agents produced output — aborting.");

    // 4 — Integrate
    setStep("integrate", "active");
    log("step", "Asking integrator to assemble the file tree…");
    const integrated = await integrateOutputs({
      apiKey: settings.anthropic,
      plan,
      outputs,
      hasSupabase: !!supabaseInfo,
      signal,
    });
    log("ok", `Integrator produced ${integrated.files.length} file(s).`);
    setStep("integrate", "done");

    // 5 — Publish
    setStep("publish", "active");

    // Inject Supabase env files if applicable
    let files = integrated.files.slice();
    if (supabaseInfo) {
      const hasEnv = files.find((f) => /^\.env(\.|$)/.test(f.path));
      if (!hasEnv) {
        files.push({
          path: ".env.example",
          content: `SUPABASE_URL=${supabaseInfo.url}\nSUPABASE_ANON_KEY=${supabaseInfo.anonKey}\n`,
        });
      }
      // Inject a env.js for static sites (so client code can read window.ENV)
      const hasEnvJs = files.find((f) => f.path === "env.js" || f.path === "config.js");
      if (!hasEnvJs) {
        files.push({
          path: "env.js",
          content: `// Auto-generated by The Agency orchestrator.\nwindow.ENV = window.ENV || {};\nwindow.ENV.SUPABASE_URL = "${supabaseInfo.url}";\nwindow.ENV.SUPABASE_ANON_KEY = "${supabaseInfo.anonKey}";\n`,
        });
      }
    }

    // Add a footer to the README crediting The Agency
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

    log("step", `Pushing ${files.length} files to ${repo.full_name}…`);
    await gh.pushFilesAsCommit(settings.github, {
      owner: repo.owner.login,
      repo: repo.name,
      branch: repo.default_branch || "main",
      message: `🎭 Initial commit by The Agency orchestrator\n\n${plan.team.length} agents · ${plan.phases.length} phases`,
      files,
    });
    log("ok", "Files pushed.");

    // Run db/schema.sql in Supabase if present
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

    // Enable Pages if the project is static
    let pagesUrl = null;
    if (plan.githubPagesReady) {
      log("step", "Enabling GitHub Pages…");
      try {
        const pages = await gh.enablePages(settings.github, {
          owner: repo.owner.login,
          repo: repo.name,
          branch: repo.default_branch || "main",
          path: "/",
        });
        pagesUrl = pages.html_url || `https://${repo.owner.login}.github.io/${repo.name}/`;
        log("ok", `Pages enabled: ${pagesUrl} (may take ~1 min for first deploy)`);
        runRecord.pagesUrl = pagesUrl;
      } catch (e) {
        log("warn", `Could not enable Pages automatically: ${e.message}`);
      }
    }
    setStep("publish", "done");

    // 6 — Done
    setStep("done", "active");
    setStep("done", "done");
    showResult({ plan, repo, pagesUrl, supabaseInfo, files, outputs });

    runRecord.status = "shipped";
    runRecord.files = files.length;
    saveRun(runRecord);

    log("ok", "🎉 Shipped.");
  } catch (err) {
    if (err.message === "aborted") {
      log("warn", "Run aborted by user.");
    } else {
      log("err", `Run failed: ${err.message}`);
      console.error(err);
    }
    runRecord.status = "failed";
    runRecord.error = err.message;
    saveRun(runRecord);
  } finally {
    currentAbort = null;
  }
}

function showResult({ plan, repo, pagesUrl, supabaseInfo, files, outputs }) {
  const panel = $("result-panel");
  const body = $("result-body");
  const links = [];
  links.push(`<div class="result-card"><h4>GitHub repo</h4><a href="${repo.html_url}" target="_blank" rel="noopener">${repo.full_name}</a></div>`);
  if (pagesUrl) links.push(`<div class="result-card"><h4>Live site</h4><a href="${pagesUrl}" target="_blank" rel="noopener">${pagesUrl}</a><br><small class="muted">First deploy can take ~60s.</small></div>`);
  if (supabaseInfo) links.push(`<div class="result-card"><h4>Supabase</h4><a href="https://supabase.com/dashboard/project/${supabaseInfo.ref}" target="_blank" rel="noopener">Dashboard</a><br><small class="muted">${supabaseInfo.url}</small></div>`);
  links.push(`<div class="result-card"><h4>Team</h4>${plan.team.length} specialists, ${outputs.length} delivered · ${files.length} files</div>`);
  body.innerHTML = `
    <p>${escapeHtml(plan.summary || "")}</p>
    <div class="result-grid">${links.join("")}</div>
    <details class="result-files"><summary>📁 ${files.length} files committed</summary>
      <ul>${files.map((f) => `<li>${escapeHtml(f.path)} <span class="muted">· ${f.content.length.toLocaleString()} chars</span></li>`).join("")}</ul>
    </details>`;
  panel.classList.remove("hidden");
}

// ----- Settings modal handlers -----
function openSettings() {
  const s = loadSettings();
  $("key-anthropic").value = s.anthropic;
  $("key-openai").value = s.openai;
  $("key-github").value = s.github;
  $("key-supabase").value = s.supabase;
  $("cfg-gh-owner").value = s.ghOwner;
  $("cfg-supabase-org").value = s.supaOrg;
  $("cfg-supabase-region").value = s.supaRegion || "us-east-1";
  $("cfg-agents-repo").value = s.agentsRepo;
  $("modal-settings").classList.remove("hidden");
}
function closeSettings() {
  $("modal-settings").classList.add("hidden");
}
function applySettings() {
  saveSettings({
    [SKEYS.anthropic]: $("key-anthropic").value.trim(),
    [SKEYS.openai]:    $("key-openai").value.trim(),
    [SKEYS.github]:    $("key-github").value.trim(),
    [SKEYS.supabase]:  $("key-supabase").value.trim(),
    [SKEYS.ghOwner]:   $("cfg-gh-owner").value.trim(),
    [SKEYS.supaOrg]:   $("cfg-supabase-org").value.trim(),
    [SKEYS.supaRegion]:$("cfg-supabase-region").value,
    [SKEYS.agentsRepo]:$("cfg-agents-repo").value.trim(),
  });
  updateSettingsPill();
  closeSettings();
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
document.addEventListener("DOMContentLoaded", async () => {
  // Auto-seed keys from config.js if present and slots are empty
  seedFromAutoConfig();

  try {
    const reg = await loadRegistry();
    $("agent-count").textContent = reg.totalAgents;
    $("division-count").textContent = reg.divisions.length;
    renderRoster();
  } catch (e) {
    log("err", `Failed to load agent registry: ${e.message}`);
  }
  updateSettingsPill();

  // Form submit
  $("idea-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const idea = $("idea").value.trim();
    if (!idea) return;
    runOrchestration(idea);
  });

  // Example chips
  document.querySelectorAll(".example-chip").forEach((b) => {
    b.addEventListener("click", () => { $("idea").value = b.dataset.example; $("idea").focus(); });
  });

  // Nav
  $("nav-roster").addEventListener("click", () => { setView("roster"); renderRoster($("roster-search").value); });
  $("nav-runs").addEventListener("click", () => { setView("runs"); renderRuns(); });
  $("nav-settings").addEventListener("click", openSettings);

  // Settings modal
  $("settings-save").addEventListener("click",