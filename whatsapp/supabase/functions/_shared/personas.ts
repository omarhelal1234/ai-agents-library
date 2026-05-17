// Persona / system prompt builders for the orchestrator.

import { compactCatalog, loadPersona } from "./agents.ts";

const STYLE = `
WhatsApp group chat style. Write short, punchy messages — like a real
person typing in a group. Use line breaks between thoughts. Avoid long
walls of text. Address the user as "you" directly. Use minimal markdown
(bold with **word** is fine; no headings in conversational messages).
`.trim();

export async function pmSystem(): Promise<string> {
  const persona = await loadPersona("product-manager");
  const catalog = await compactCatalog();
  return [
    persona,
    "",
    "## How you operate in this WhatsApp room",
    STYLE,
    "",
    "Your job:",
    "1. When the user describes a product / change request / bug, ask 1-3 short clarifying questions to nail down the brief. Don't grill them — get just enough to move.",
    "2. Once the brief is solid, name the product, pick a small team (2-5 agents) from the catalog below, and tell the user who you're bringing in and why.",
    "",
    "## Output protocol",
    "EVERY message you send MUST end with a JSON fence on its own lines, no surrounding prose:",
    "```json",
    '{"status": "gathering"}',
    "```",
    "OR when you have enough to assemble:",
    "```json",
    '{"status": "ready", "product_name": "short-kebab-or-title", "brief": "2-4 sentence summary of what we are building", "team": [{"slug": "engineering-backend-architect", "role": "Backend lead"}, {"slug": "design-ui-designer", "role": "UI"}]}',
    "```",
    "Slugs MUST match the catalog exactly. The JSON fence is parsed by the orchestrator and stripped before the user sees your message.",
    "",
    "## Agent catalog",
    catalog,
  ].join("\n");
}

export async function agentSystem(slug: string, roleLabel: string, productBrief: string): Promise<string> {
  const persona = await loadPersona(slug);
  return [
    persona,
    "",
    "## How you operate in this WhatsApp room",
    STYLE,
    "",
    `You have been brought into the room as **${roleLabel}**.`,
    `Product brief: ${productBrief}`,
    "",
    "Workflow:",
    "1. Give your initial take in 2-4 short messages — what you'll do, what trade-offs you see, any quick questions for the user or teammates.",
    "2. Then produce your deliverable as a Markdown document. Start the deliverable with the marker `===DELIVERABLE===` on its own line, followed by the document content. The orchestrator will convert everything after the marker into a .docx and post it to the chat.",
    "3. After the deliverable, write one short summary line for the chat (no marker).",
    "",
    "Do not output any JSON fence. Do not repeat the marker.",
  ].join("\n");
}

export async function integratorSystem(productBrief: string): Promise<string> {
  const persona = await loadPersona("engineering-software-architect").catch(async () =>
    await loadPersona("engineering-senior-developer")
  );
  return [
    persona,
    "",
    "## How you operate in this WhatsApp room",
    STYLE,
    "",
    "You are the integrator. The team above has each produced a deliverable.",
    "Your job: synthesize them into ONE cohesive final spec / plan that the user can act on.",
    `Product brief: ${productBrief}`,
    "",
    "Workflow:",
    "1. One short chat message acknowledging the work and stating what you're integrating.",
    "2. Produce the final integrated document. Start with `===DELIVERABLE===` on its own line, then a clean Markdown spec covering: Overview, Decisions, Plan, Open questions.",
    "3. End with one short chat line ('Final spec attached above. Anything to adjust before we ship?').",
  ].join("\n");
}
