# 🎭 The Agency — Orchestrator (GitHub Pages app)

A single-page app that lets you describe an idea, watch the orchestrator pick a team from this repo's 180+ specialist agents, and ship the result to a brand-new GitHub repo (plus a brand-new Supabase project when a backend is needed).

Everything runs in your browser. No server, no build step. Just static files in `docs/`.

---

## What it does

1. **You describe an idea** in the textarea.
2. **Orchestrator (Claude Sonnet)** reads your idea + the full agent catalog and returns a phased plan: which agents to deploy, in which order, with concrete tasks.
3. **Provision** — the app creates a new GitHub repo via your PAT. If the plan flags `needsDatabase`, it also creates a new Supabase project via your Supabase token, waits for `ACTIVE_HEALTHY`, and grabs the anon key.
4. **Workers run in parallel** per phase. Each agent uses its full persona (`.md` file) as system prompt. Routing: engineering / testing / spatial → Claude; marketing / copy → OpenAI when a key is present; otherwise Claude.
5. **Integrator (Claude)** merges all worker outputs into a clean file tree.
6. **Publish** — the integrated files are pushed to the new repo in a single commit (Git Data API), `env.js` / `.env.example` are auto-injected with Supabase creds, `db/schema.sql` is applied to Supabase if present, and GitHub Pages is enabled.

You end with a live URL, a repo URL, and (when relevant) a Supabase dashboard URL.

---

## One-time setup

### 1. Enable GitHub Pages for this repo

In your fork:

- **Settings → Pages → Source: `Deploy from a branch`**
- **Branch: `main`** · **Folder: `/docs`** → Save.

In ~30 seconds you'll get `https://<your-username>.github.io/<repo-name>/`.

### 2. Open the app and configure keys

Open the URL above, click **⚙️ Settings**, and paste:

| Key | Where to get it | Required? |
|-----|-----------------|-----------|
| **Anthropic API key** | [console.anthropic.com](https://console.anthropic.com/) | ✅ Required |
| **OpenAI API key** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Optional (improves routing) |
| **GitHub personal access token** | [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) — Fine-grained PAT with `repo`, `administration` (Pages), `contents:write` | ✅ Required |
| **Supabase personal access token** | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) | Required only for projects with a database |
| **Supabase organization ID** | Click *Load my orgs* in Settings after entering the token | Required for Supabase |

All values are stored only in your browser's `localStorage`. They never leave your machine except as Authorization headers on requests to the four provider APIs.

### 3. Run

Type an idea, click **🚀 Orchestrate**, watch the board.

---

## How to update the agent index

Whenever agents are added, removed, or renamed in this repo:

```bash
python3 docs/scripts/build-index.py
git add docs/data/agents.json
git commit -m "Reindex agents"
git push
```

The orchestrator reads `docs/data/agents.json` on every page load.

---

## File layout

```
docs/
├── index.html          # main UI
├── styles.css
├── README.md           # this file
├── data/
│   └── agents.json     # generated index of all agents
├── scripts/
│   └── build-index.py  # regenerator
└── js/
    ├── main.js         # UI + run controller
    ├── agents.js       # registry loader + persona fetcher
    ├── orchestrator.js # plan + integrate prompts
    ├── runner.js       # parallel phase runner
    ├── api.js          # Anthropic + OpenAI clients
    ├── github.js       # repo / commit / Pages API
    └── supabase.js     # Management API client
```

---

## How it picks models

The orchestrator emits a `model` field per worker (`"claude"` or `"openai"`). When `openai` is requested but no OpenAI key is configured, the runner falls back to Claude. Division defaults (when the model is unspecified):

- Engineering, Testing, Spatial Computing, Game Development, Specialized, Product, PM, Academic → **Claude**
- Marketing, Design, Sales, Paid Media → **OpenAI** if available, else **Claude**

You can change this in `js/api.js` → `pickModel`.

---

## Security & cost notes

- **API keys are never sent to a server we control** — only to the Anthropic, OpenAI, GitHub, and Supabase APIs directly. If you share the URL, anyone using it sees only their own keys, not yours.
- **Token scopes** — the GitHub PAT can create repos and enable Pages. The Supabase token has full org access. Treat both like passwords.
- **Cost** — each run is roughly 50k–300k LLM tokens depending on team size and depth. A typical 6-agent run on Claude Sonnet costs a few cents to a couple dollars. Watch your dashboards.
- **CORS** — Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header for browser use. This is enabled by default in `js/api.js`. The name is deliberately scary — anything in the browser is visible to the user, so don't deploy this URL with shared keys baked in.

---

## Troubleshooting

**The orchestrator picks invalid slugs.** Re-run `build-index.py` to make sure `data/agents.json` is up to date.

**Anthropic 401.** Wrong key, or the key doesn't have access to the Claude Sonnet 4.5 model. Edit `DEFAULT_CLAUDE_MODEL` in `js/api.js` to a model you have access to.

**GitHub 403 on repo create.** PAT is missing the `repo` scope. For fine-grained tokens, enable `Repository access: All` and check `Administration` + `Contents`.

**Supabase project stuck "COMING_UP".** Free-tier provisioning can take 90s+. The runner waits up to 3 minutes. If it times out, the project will still appear in your dashboard and you can use it manually.

**Pages 404 after publish.** First deploy takes ~60s. Refresh.

---

_Source: [agency-agents](https://github.com/msitarzewski/agency-agents) · MIT._
