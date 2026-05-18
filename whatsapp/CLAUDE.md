# CLAUDE.md — whatsapp/

Instructions for Claude (and any other agentic assistant) when working
inside `whatsapp/`. This file is loaded automatically when the working
directory or task touches this folder.

## Rule 0 — Cowork with codex CLI before delivering any change or fix

**THIS IS THE MOST IMPORTANT RULE.**

Before you mark any change/fix in this directory as "done" and hand it
back to the user, you MUST coreview the diff with the `codex` CLI. The
WhatsApp pipeline has live production state (a linked WA Web session,
paid LLM calls, a single owner's chat history) — single-pass changes
have repeatedly missed regressions. Codex catches them.

Workflow:

1. Write your change.
2. Run `codex` (or `codex exec`) and ask it to review the diff with the
   specific intent of the change. Hand it:
   - The user's request, verbatim.
   - The diff (`git diff` or the modified files).
   - The constraint that broke last time (anti-throttling flags,
     interrupt handling, single-bridge-call-per-turn, sender allowlist,
     provider routing — see "Load-bearing invariants" below).
3. Read codex's reply. Apply any fixes it suggests that you agree with.
   If you disagree, write down why in your reply to the user.
4. Only then say the change is ready.

If codex isn't installed or auth'd in the current env, surface that to
the user before proceeding — do not skip the step silently.

This rule applies to: bridge changes, edge function changes, persona
edits, schema migrations, README/docs that ship behavior. It does NOT
apply to: typo fixes in comments, this CLAUDE.md itself.

## Architecture (quick map)

See [README.md](README.md) for the full picture. Skim:

- `bridge/src/index.js` — Node + whatsapp-web.js + Express. Runs on
  Railway with a persistent volume for the WA Web session.
- `supabase/functions/wa-inbound/index.ts` — webhook entry, routes
  inbound messages, kicks `run-phase` in the background.
- `supabase/functions/run-phase/index.ts` — the agent loop. One
  invocation runs ONE chunk (one agent's turn, or one phase transition)
  and self-recurses via background fetch.
- `supabase/functions/_shared/llm.ts` — unified streaming wrapper for
  Anthropic + OpenAI. `providerForAgent(slug, division)` decides which
  provider runs which agent.
- `supabase/functions/_shared/personas.ts` — system prompt builders.
- `supabase/functions/_shared/agents.ts` — fetches the agent catalog and
  individual persona `.md` files from the public GitHub repo.

## Load-bearing invariants — do not break these without a deliberate decision

These are the things that have bitten this codebase before. Treat any
diff that touches them with extra care.

1. **Sender allowlist.** This system is single-tenant by design. The
   only sender it serves is `201099922763@c.us`. Enforced in two
   places — bridge (`OWNER_WA_ID` default) and edge function
   (`ALLOWED_WA_CHAT_ID` default). Both defaults are hardcoded so an
   unset env doesn't open the system up. Do not remove either check.

2. **Per-agent LLM routing.** PM (`product-manager`) → OpenAI for JSON
   shape discipline. Integrator (`engineering-software-architect`)
   → Anthropic for long-form synthesis. Build agents → routed by
   division in `providerForAgent`. When adding a new fixed-role agent,
   add it to `providerForAgent` explicitly.

3. **One bridge call per agent turn.** `streamToChat` accumulates the
   full stream and sends ONE WhatsApp message at the end. Do NOT send
   per-chunk — each bridge call goes through Puppeteer + WA Web and
   costs hundreds of ms. Edge Functions wall-time-cap at 150s. The only
   in-stream side effect should be `hasPendingInterrupt` polling.

4. **Interrupt handling.** Mid-stream user messages are written into
   `wa_interrupts`. The active stream polls `hasPendingInterrupt`
   between sentence chunks and aborts when one fires. The orchestrator
   then self-recurses with the new transcript. Don't change this to
   "wait for the current agent to finish" — that defeats the whole
   point of WhatsApp pacing.

5. **Chromium anti-throttling flags.** The flags in
   `bridge/src/index.js` (`--disable-background-timer-throttling`,
   `--disable-backgrounding-occluded-windows`,
   `--disable-renderer-backgrounding`, etc.) and the 10s keepalive
   interval are the reason the bridge stays alive on Railway. Headless
   Chromium pauses JS in occluded renderers by default, which on a
   server (always occluded) means the WA Web heartbeat stalls. Don't
   loosen the flags or stretch the keepalive interval without a plan
   for the regression that follows.

6. **`message_create` only, never `message`.** Listening on both
   produces duplicate inbound forwards, which downstream become
   spurious interrupts that abort live agent streams. See the comment
   in `bridge/src/index.js`.

7. **Singleton lock sweep on boot.** Chromium leaves
   `SingletonLock`/`SingletonCookie`/`SingletonSocket` files in the
   profile dir. On a mounted Railway volume those persist across
   container kills and the next boot thinks another browser is alive.
   `cleanChromiumLocks` removes them. Leave it.

## Environment

See README for the canonical list. Quick reference of what each side
needs:

**Supabase Edge Function secrets**

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
BRIDGE_SECRET=<shared with Railway>
BRIDGE_URL=https://<railway-app>.up.railway.app
RUN_PHASE_URL=https://<project>.supabase.co/functions/v1/run-phase
CLAUDE_MODEL=claude-sonnet-4-6     # optional
OPENAI_MODEL=gpt-4o                # optional
ALLOWED_WA_CHAT_ID=201099922763@c.us  # optional; default is hardcoded
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

**Railway bridge**

```
BRIDGE_SECRET=<same as Supabase>
SUPABASE_WEBHOOK_URL=https://<project>.supabase.co/functions/v1/wa-inbound
SUPABASE_SERVICE_ROLE=<key>
OWNER_WA_ID=201099922763@c.us       # optional override; default hardcoded
```

## Deploy

- **Edge functions**: `supabase functions deploy run-phase wa-inbound`
  from repo root with `supabase link --project-ref ztdwgrlregbcgtalqkuh`.
  Note the current production functions are shims that load this repo's
  `main` branch at cold start — so on most changes you just push to
  `main` and the next cold start picks it up. Re-deploy explicitly if
  you change the shim itself.
- **Bridge**: `git push` to whatever branch Railway is wired to. Railway
  rebuilds and restarts. The QR session persists on the mounted volume.

## Local development

- Bridge: `cd bridge && npm install && npm start`. Needs
  `BRIDGE_SECRET`, `SUPABASE_WEBHOOK_URL`, `SUPABASE_SERVICE_ROLE` in
  env. Use `cloudflared tunnel --url http://localhost:8080` (or similar)
  to expose `/send` to the Supabase function during testing.
- Edge functions: `supabase functions serve` after linking.

## Testing changes

There is no automated test suite for the WhatsApp flow today. After any
non-trivial change:

1. Cowork with codex (Rule 0).
2. Deploy to a scratch Supabase project OR run the edge functions
   locally with `supabase functions serve`.
3. Send a real message from `201099922763` and watch the logs through
   discovery → awaiting_go → build → integrate → done.
4. Send a `/reset` mid-flow to confirm interrupt handling still works.

If you can't actually exercise the WhatsApp flow before reporting back,
say so explicitly — don't claim it works because types check.

## Style notes

- TypeScript for edge functions, JavaScript (ESM) for the bridge — the
  repo isn't migrating to TS for the bridge, don't propose it.
- Edge function code uses `Deno.serve` and `jsr:`/`npm:` specifiers.
  No build step.
- WhatsApp-facing copy lives in `personas.ts`. Keep it short and
  conversational — see the `STYLE` constant.
- Don't add comments that describe what the code does. Add comments
  only for non-obvious *why* (e.g., the anti-throttling flag block).
