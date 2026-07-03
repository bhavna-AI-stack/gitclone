import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "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";
const VERCEL_TOKEN = Deno.env.get("VERCEL_TOKEN") ?? "vcp_5XD0054FJvGgrRGhIV5VAguNRpqmntAT5RJZEzhLEy0rNooQZl2agIsz";

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url.trim());
    const parts = u.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ghRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function ghGet(path: string, token: string): Promise<unknown> {
  const { ok, status, data } = await ghRequest("GET", path, token);
  if (!ok) throw new Error(`GET ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPost(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghRequest("POST", path, token, body);
  if (!ok) throw new Error(`POST ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPatch(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghRequest("PATCH", path, token, body);
  if (!ok) throw new Error(`PATCH ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPut(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghRequest("PUT", path, token, body);
  if (!ok) throw new Error(`PUT ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

/** Returns true if the repo has at least one git ref (i.e. is not empty). */
async function repoHasCommits(owner: string, repo: string, token: string): Promise<boolean> {
  const { ok, data } = await ghRequest("GET", `/repos/${owner}/${repo}/git/refs`, token);
  if (!ok) return false;
  return Array.isArray(data) && (data as unknown[]).length > 0;
}

/**
 * Seed an empty repo with a single placeholder commit so GitHub's git backend
 * is fully initialized before we push blobs/trees.
 */
async function seedEmptyRepo(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<void> {
  await ghPut(
    `/repos/${owner}/${repo}/contents/.gitkeep`,
    {
      message: "Initialize repository",
      content: btoa(""),
      branch,
    },
    token
  );
  // Let GitHub propagate the new ref
  await sleep(2000);
}

async function copyRepo(
  srcOwner: string,
  srcRepo: string,
  dstOwner: string,
  dstRepo: string,
  token: string
): Promise<void> {
  // ── 1. Read source ──────────────────────────────────────────────────────
  const srcInfo = await ghGet(`/repos/${srcOwner}/${srcRepo}`, token) as Record<string, string>;
  const defaultBranch: string = srcInfo.default_branch ?? "main";

  const refData = await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/ref/heads/${defaultBranch}`,
    token
  ) as { object: { sha: string } };
  const commitSha = refData.object.sha;

  const commitData = await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/commits/${commitSha}`,
    token
  ) as { tree: { sha: string } };
  const treeSha = commitData.tree.sha;

  const treeData = await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/trees/${treeSha}?recursive=1`,
    token
  ) as { tree: Array<{ path: string; type: string; sha: string; mode: string }> };
  const items = treeData.tree;

  // ── 2. Ensure target repo exists and is initialized ─────────────────────
  const repoCheck = await ghRequest("GET", `/repos/${dstOwner}/${dstRepo}`, token);

  if (!repoCheck.ok) {
    // Create repo with auto_init so GitHub sets up the git backend immediately
    try {
      await ghPost(`/user/repos`, { name: dstRepo, private: false, auto_init: true }, token);
    } catch {
      await ghPost(`/orgs/${dstOwner}/repos`, { name: dstRepo, private: false, auto_init: true }, token);
    }
    await sleep(3000); // Wait for GitHub to provision the git backend
  } else {
    // Repo exists — make sure it has at least one commit
    const hasCommits = await repoHasCommits(dstOwner, dstRepo, token);
    if (!hasCommits) {
      // Get the default branch that GitHub assigned to this repo
      const dstInfo = await ghGet(`/repos/${dstOwner}/${dstRepo}`, token) as Record<string, string>;
      const dstDefault = dstInfo.default_branch ?? defaultBranch;
      await seedEmptyRepo(dstOwner, dstRepo, dstDefault, token);
    }
  }

  // Get the actual default branch of the target repo (may differ after auto_init)
  const dstInfo = await ghGet(`/repos/${dstOwner}/${dstRepo}`, token) as Record<string, string>;
  const dstBranch: string = dstInfo.default_branch ?? defaultBranch;

  // ── 3. Copy blobs from source → destination ──────────────────────────────
  const newTreeEntries: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];

  for (const item of items) {
    if (item.type === "blob") {
      const blob = await ghGet(
        `/repos/${srcOwner}/${srcRepo}/git/blobs/${item.sha}`,
        token
      ) as { content: string; encoding: string };

      const newBlob = await ghPost(
        `/repos/${dstOwner}/${dstRepo}/git/blobs`,
        { content: blob.content, encoding: blob.encoding },
        token
      ) as { sha: string };

      newTreeEntries.push({
        path: item.path,
        mode: item.mode,
        type: "blob",
        sha: newBlob.sha,
      });
    }
    // Skip "tree" entries — the Create Tree API builds subtrees automatically
  }

  // ── 4. Create tree ───────────────────────────────────────────────────────
  const newTree = await ghPost(
    `/repos/${dstOwner}/${dstRepo}/git/trees`,
    { tree: newTreeEntries },
    token
  ) as { sha: string };

  // ── 5. Create commit (parent = current HEAD of dst branch) ───────────────
  let parentShas: string[] = [];
  const refCheck = await ghRequest("GET", `/repos/${dstOwner}/${dstRepo}/git/ref/heads/${dstBranch}`, token);
  if (refCheck.ok) {
    const refObj = refCheck.data as { object: { sha: string } };
    parentShas = [refObj.object.sha];
  }

  const newCommit = await ghPost(
    `/repos/${dstOwner}/${dstRepo}/git/commits`,
    {
      message: `Copy from ${srcOwner}/${srcRepo}`,
      tree: newTree.sha,
      parents: parentShas,
    },
    token
  ) as { sha: string };

  // ── 6. Update or create branch ref ──────────────────────────────────────
  if (refCheck.ok) {
    // Ref exists → force-update it
    await ghPatch(
      `/repos/${dstOwner}/${dstRepo}/git/refs/heads/${dstBranch}`,
      { sha: newCommit.sha, force: true },
      token
    );
  } else {
    // Ref doesn't exist → create it
    await ghPost(
      `/repos/${dstOwner}/${dstRepo}/git/refs`,
      { ref: `refs/heads/${dstBranch}`, sha: newCommit.sha },
      token
    );
  }
}

async function deployToVercel(
  dstOwner: string,
  dstRepo: string,
  vercelToken: string
): Promise<string> {
  const projectName = `${dstRepo}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 52);

  // Create a Vercel project linked to the GitHub repo
  const createRes = await fetch("https://api.vercel.com/v9/projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      gitRepository: {
        repo: `${dstOwner}/${dstRepo}`,
        type: "github",
      },
    }),
  });

  const project = await createRes.json() as Record<string, unknown>;
  if (!createRes.ok) throw new Error(`Vercel create project failed: ${JSON.stringify(project)}`);

  const projectId = project.id as string;

  // Poll up to 150 s for the deployment to reach READY
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const deplRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=1`,
      { headers: { Authorization: `Bearer ${vercelToken}` } }
    );
    const deplData = await deplRes.json() as { deployments?: Array<{ state: string; url: string }> };
    const deployments = deplData.deployments ?? [];
    if (deployments.length > 0) {
      const d = deployments[0];
      if (d.state === "READY") return `https://${d.url}`;
      if (d.state === "ERROR" || d.state === "CANCELED") {
        throw new Error(`Vercel deployment ended with state: ${d.state}`);
      }
    }
  }

  // Return a predictable project URL if polling times out
  return `https://${projectName}.vercel.app`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { sourceUrl, targetUrl } = await req.json() as {
      sourceUrl?: string;
      targetUrl?: string;
    };

    if (!sourceUrl || !targetUrl) {
      return new Response(
        JSON.stringify({ error: "sourceUrl and targetUrl are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const src = parseGitHubUrl(sourceUrl);
    const dst = parseGitHubUrl(targetUrl);

    if (!src) {
      return new Response(
        JSON.stringify({ error: "Invalid source GitHub URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!dst) {
      return new Response(
        JSON.stringify({ error: "Invalid target GitHub URL" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not configured");
    if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN not configured");

    await copyRepo(src.owner, src.repo, dst.owner, dst.repo, GITHUB_TOKEN);
    const liveUrl = await deployToVercel(dst.owner, dst.repo, VERCEL_TOKEN);

    return new Response(
      JSON.stringify({
        success: true,
        copiedRepo: `https://github.com/${dst.owner}/${dst.repo}`,
        liveUrl,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
