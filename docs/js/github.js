// GitHub REST API client for browser use.
// Auth: personal access token with `repo` scope (and `workflow` for Actions).
// Used to create a new repo per orchestrator run, push files via the Git Data API
// (single commit, many files), and enable GitHub Pages.

const GH = "https://api.github.com";

function headers(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${GH}${path}`, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${init.method || "GET"} ${path}: ${txt.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Browser-safe base64 of UTF-8 strings (handles emoji, accents, etc.)
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function getViewer(token) {
  return gh(token, `/user`);
}

export async function createRepo(token, { name, description, isPrivate = false, owner = null }) {
  // If owner given and it's the user's own login, still use /user/repos.
  // If owner is an org, use /orgs/:org/repos.
  let path = `/user/repos`;
  if (owner) {
    const viewer = await getViewer(token);
    if (viewer.login.toLowerCase() !== owner.toLowerCase()) {
      path = `/orgs/${encodeURIComponent(owner)}/repos`;
    }
  }
  return gh(token, path, {
    method: "POST",
    body: JSON.stringify({
      name, description, private: isPrivate,
      auto_init: true,
      has_issues: true, has_projects: false, has_wiki: false,
    }),
  });
}

// Push many files in a single commit using the Git Data API.
// `files` is [{ path, content }] where content is utf-8 string.
export async function pushFilesAsCommit(token, { owner, repo, branch = "main", message, files }) {
  // 1. Get the SHA of the branch HEAD
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const parentSha = ref.object.sha;

  // 2. Get the base tree
  const parentCommit = await gh(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const baseTreeSha = parentCommit.tree.sha;

  // 3. Create a blob for each file
  const blobs = [];
  for (const f of files) {
    const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: b64utf8(f.content), encoding: "base64" }),
    });
    blobs.push({ path: f.path.replace(/^\//, ""), mode: "100644", type: "blob", sha: blob.sha });
  }

  // 4. Create a tree referencing the new blobs (additive against base tree)
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: blobs }),
  });

  // 5. Create a commit
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });

  // 6. Update the ref
  await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return commit;
}

export async function enablePages(token, { owner, repo, branch = "main", path = "/" }) {
  // Try POST first (creates Pages site). If it 409s, the site exists — PUT updates the source.
  try {
    return await gh(token, `/repos/${owner}/${repo}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: { branch, path } }),
    });
  } catch (e) {
    // PUT to update existing
    return await gh(token, `/repos/${owner}/${repo}/pages`, {
      method: "PUT",
      body: JSON.stringify({ source: { branch, path } }),
    });
  }
}

export async function getPagesInfo(token, { owner, repo }) {
  try {
    return await gh(token, `/repos/${owner}/${repo}/pages`);
  } catch (e) {
    return null;
  }
}

// Slugify a project name for use as a repo name
export function slugifyRepoName(name) {
  return (name || "agency-project")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 80) || "agency-project";
}
