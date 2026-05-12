// Agent registry: loads docs/data/agents.json on startup, and fetches the
// full persona markdown (the agent's .md file) on demand from raw.githubusercontent.com.

let registry = null;
const personaCache = new Map();

export async function loadRegistry() {
  if (registry) return registry;
  const res = await fetch("data/agents.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Failed to load agents.json");
  registry = await res.json();
  return registry;
}

export function getRegistry() {
  return registry;
}

export function getAgentBySlug(slug) {
  if (!registry) return null;
  return registry.agents.find((a) => a.slug === slug) || null;
}

export function agentsByDivision() {
  if (!registry) return {};
  const out = {};
  for (const a of registry.agents) {
    if (!out[a.division]) out[a.division] = [];
    out[a.division].push(a);
  }
  return out;
}

// Build a compact catalog string for the orchestrator prompt.
// One line per agent: slug | division | name | description
export function buildCatalogForPrompt(maxLen = 280) {
  if (!registry) return "";
  return registry.agents
    .map((a) => {
      const desc = (a.description || "").replace(/\s+/g, " ").slice(0, maxLen);
      return `${a.slug} | ${a.division} | ${a.name} — ${desc}`;
    })
    .join("\n");
}

// Fetch the full persona markdown for an agent.
// Uses raw.githubusercontent.com so it works regardless of GH Pages folder layout.
export async function fetchPersona(slug, { owner, repo, branch = "main" }) {
  if (personaCache.has(slug)) return personaCache.get(slug);
  const a = getAgentBySlug(slug);
  if (!a) throw new Error(`Unknown agent: ${slug}`);
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${a.path}`;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    // Fallback: try fetching relative to the site (works when running locally
    // with the agents folder served alongside docs/)
    const localUrl = `../${a.path}`;
    const local = await fetch(localUrl).catch(() => null);
    if (local && local.ok) {
      const t = await local.text();
      personaCache.set(slug, t);
      return t;
    }
    throw new Error(`Failed to fetch persona for ${slug} (${res.status})`);
  }
  const text = await res.text();
  personaCache.set(slug, text);
  return text;
}

// Strip the agent's YAML frontmatter — the LLM only needs the body.
export function stripFrontmatter(md) {
  return md.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
}
