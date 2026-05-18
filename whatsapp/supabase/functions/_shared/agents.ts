// Agent catalog + persona loader.
// Pulls the agent index and individual .md files from the public GitHub repo.

const REPO_RAW = "https://raw.githubusercontent.com/omarhelal1234/ai-agents-library/main";
const INDEX_URL = `${REPO_RAW}/docs/data/agents.json`;

export type AgentMeta = {
  slug: string;
  name: string;
  description: string;
  division: string;
  path: string;
};

type Index = { agents: AgentMeta[] };

let _index: Index | null = null;
const _personas = new Map<string, string>();

export async function loadIndex(): Promise<AgentMeta[]> {
  if (_index) return _index.agents;
  const r = await fetch(INDEX_URL);
  if (!r.ok) throw new Error(`agents.json fetch failed: ${r.status}`);
  _index = await r.json();
  return _index!.agents;
}

export async function findAgent(slug: string): Promise<AgentMeta | null> {
  const all = await loadIndex();
  return all.find((a) => a.slug === slug) ?? null;
}

export async function loadPersona(slug: string): Promise<string> {
  if (_personas.has(slug)) return _personas.get(slug)!;
  const meta = await findAgent(slug);
  if (!meta) throw new Error(`unknown agent: ${slug}`);
  const r = await fetch(`${REPO_RAW}/${meta.path}`);
  if (!r.ok) throw new Error(`persona fetch failed: ${meta.path} ${r.status}`);
  const text = await r.text();
  _personas.set(slug, text);
  return text;
}

// Compact catalog the PM agent sees when picking a team. Each entry is
// `slug (name) — short hint`, grouped by division. Descriptions are
// truncated to ~90 chars: enough to disambiguate agents whose name alone
// is generic (e.g. "Senior Developer", "Evidence Collector"), without
// reintroducing the full ~12k-token description block that previously
// pushed PM calls over the OpenAI TPM budget.
export async function compactCatalog(): Promise<string> {
  const all = await loadIndex();
  const by: Record<string, AgentMeta[]> = {};
  for (const a of all) (by[a.division] ??= []).push(a);
  const out: string[] = [];
  for (const div of Object.keys(by).sort()) {
    out.push(`## ${div}`);
    for (const a of by[div]) {
      const hint = a.description.length > 90
        ? `${a.description.slice(0, 87)}...`
        : a.description;
      out.push(`- ${a.slug} (${a.name}) — ${hint}`);
    }
  }
  return out.join("\n");
}
