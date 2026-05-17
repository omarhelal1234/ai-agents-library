# WhatsApp interface for The Agency

Group-chat-style multi-agent orchestrator over WhatsApp. You DM a number,
a PM agent clarifies your brief, assembles a team from the 184-agent
library, the team chats through the work, and you get a `.docx` per
agent plus a final integrated spec.

## Architecture

```
WhatsApp <─► Bridge (Railway)          ─POST─►  wa-inbound (Edge Fn)
              whatsapp-web.js                          │
              Node + Chromium                          │ kicks
              persistent volume                        ▼
                  ▲                            run-phase (Edge Fn)
                  │  /send, /send-doc            │  agent loop
                  └──────────────────────────────┘  streams chunks
                                                  Claude API
                                                  Supabase Postgres
                                                  Supabase Storage
```

- **Bridge** ([bridge/](bridge/)) — Node service. Holds the WhatsApp Web
  session via `whatsapp-web.js`, forwards inbound messages to a Supabase
  Edge Function, and exposes a small HTTP API the function calls back to
  for outbound sends. Runs on Railway with a persistent volume so the QR
  session survives restarts.
- **Orchestrator** ([supabase/functions/](supabase/functions/)) — two
  Edge Functions. `wa-inbound` routes incoming messages (new product /
  interrupt / continuation). `run-phase` is the agent loop: streams each
  agent's response sentence-by-sentence to the bridge, generates a
  `.docx` deliverable per agent, and self-recurses to advance phases.
- **State** — Postgres tables (`wa_conversations`, `wa_products`,
  `wa_messages`, `wa_assignments`, `wa_interrupts`, `wa_artifacts`).
  Storage bucket `wa-artifacts` holds the `.docx` files.

## Phases

| Phase | What happens |
|-------|--------------|
| `discovery` | PM ("Sarah") asks 1–3 clarifying questions, then emits a JSON fence with the brief + chosen team. |
| `awaiting_go` | Bot lists the team. Reply *go* (or yes/ok/let's go) to start. |
| `build` | Each assigned agent streams chat, then posts their `.docx`. |
| `integrate` | "Marcus" (Software Architect) synthesizes one final spec. |
| `done` | Wrap-up. Next message starts a new product. |

Send any message mid-flow and it's queued as an interrupt — the active
agent's stream aborts at the next sentence boundary, and the run resumes
with your input in the transcript.

Send `/reset` to wipe the conversation state.

## Setup

### 1. Supabase

DB tables and storage bucket are already migrated on the
`agency-orchestrator-state` project (Supabase project ref
`ztdwgrlregbcgtalqkuh`). The Edge Functions deploy as shims that load
the real code from this repo's `main` branch at cold start.

Set these secrets in the Supabase dashboard
(Project → Edge Functions → Secrets):

```
ANTHROPIC_API_KEY=sk-ant-...
BRIDGE_SECRET=<long-random-string-you-also-set-on-railway>
BRIDGE_URL=https://<your-railway-app>.up.railway.app
RUN_PHASE_URL=https://ztdwgrlregbcgtalqkuh.supabase.co/functions/v1/run-phase
CLAUDE_MODEL=claude-sonnet-4-6      # optional, defaults to this
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the
Edge Functions runtime — you don't set those manually.

### 2. Railway bridge

1. Create a new Railway project and connect this repo.
2. Set the **Root Directory** to `whatsapp/bridge`.
3. Add a **Volume**, mount path `/data`. This persists the WhatsApp Web
   session — without it you'll re-scan the QR every restart.
4. Set environment variables:
   ```
   BRIDGE_SECRET=<same as Supabase>
   SUPABASE_WEBHOOK_URL=https://ztdwgrlregbcgtalqkuh.supabase.co/functions/v1/wa-inbound
   SUPABASE_SERVICE_ROLE=<the service role key — Supabase Dashboard → Project Settings → API>
   OWNER_WA_ID=<your-number>@c.us    # optional, restricts to your number
   ```
5. Deploy. Open the Railway logs and you'll see a QR code printed in
   ASCII. On your phone: **WhatsApp → Settings → Linked Devices → Link a
   Device** and scan. The bridge logs `ready.` once linked.

### 3. Verify

DM the linked WhatsApp number something like
*"I want a landing page for an early-access waitlist for a new note-taking app."*

You should see Sarah respond within a few seconds, ask a couple
questions, then propose a team.

## Local development

- The bridge runs locally with `npm start` after `npm install` — it
  needs `BRIDGE_SECRET`, `SUPABASE_WEBHOOK_URL`, `SUPABASE_SERVICE_ROLE`
  in env. For the Supabase webhook to reach you, tunnel with `cloudflared
  tunnel --url http://localhost:8080` or similar.
- Edge Functions can be served locally with `supabase functions serve`
  after `supabase link --project-ref ztdwgrlregbcgtalqkuh`.

## Limits today (intentional, in scope)

- Single 1:1 chat per user. No auto-created per-product groups yet (the
  WA Web API can create groups; wiring is a follow-up).
- One product at a time per WhatsApp chat. Send `/reset` or finish the
  current product before starting another.
- Streaming sentence pacing approximates real typing but isn't perfect —
  some agents emit dense paragraphs.

## Files

```
whatsapp/
├── bridge/                              Railway Node service
│   ├── src/index.js                       whatsapp-web.js + Express API
│   ├── Dockerfile
│   ├── railway.toml
│   └── package.json
└── supabase/
    ├── migrations/                        DB schema (already applied)
    └── functions/
        ├── _shared/
        │   ├── agents.ts                    catalog + persona loader (from raw GH)
        │   ├── bridge.ts                    client for the WA bridge
        │   ├── claude.ts                    streaming Claude wrapper
        │   ├── db.ts                        Postgres + Storage helpers
        │   ├── docx.ts                      markdown → .docx
        │   └── personas.ts                  system prompt builders
        ├── wa-inbound/index.ts              webhook entry
        └── run-phase/index.ts               agent loop
```
