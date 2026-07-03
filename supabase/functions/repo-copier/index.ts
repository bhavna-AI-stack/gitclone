import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GITHUB_TOKEN =
  Deno.env.get("GITHUB_TOKEN") ??
  "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";
const VERCEL_TOKEN =
  Deno.env.get("VERCEL_TOKEN") ??
  "vcp_5XD0054FJvGgrRGhIV5VAguNRpqmntAT5RJZEzhLEy0rNooQZl2agIsz";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ── GitHub helpers ──────────────────────────────────────────────────────────

const GH_BASE = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${GH_BASE}${path}`, {
    method,
    headers: ghHeaders(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function ghGet(path: string, token: string): Promise<unknown> {
  const { ok, status, data } = await ghFetch("GET", path, token);
  if (!ok) throw new Error(`GET ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPost(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghFetch("POST", path, token, body);
  if (!ok) throw new Error(`POST ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPatch(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghFetch("PATCH", path, token, body);
  if (!ok) throw new Error(`PATCH ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

async function ghPut(path: string, body: unknown, token: string): Promise<unknown> {
  const { ok, status, data } = await ghFetch("PUT", path, token, body);
  if (!ok) throw new Error(`PUT ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Repo initialization ─────────────────────────────────────────────────────

async function repoHasCommits(owner: string, repo: string, token: string): Promise<boolean> {
  const { ok, data } = await ghFetch("GET", `/repos/${owner}/${repo}/git/refs`, token);
  return ok && Array.isArray(data) && (data as unknown[]).length > 0;
}

async function ensureRepoReady(
  owner: string,
  repo: string,
  defaultBranch: string,
  token: string
): Promise<string /* actual default branch */> {
  const check = await ghFetch("GET", `/repos/${owner}/${repo}`, token);

  if (!check.ok) {
    // Create brand-new repo with auto_init so git backend is set up immediately
    try {
      await ghPost(`/user/repos`, { name: repo, private: false, auto_init: true }, token);
    } catch {
      await ghPost(
        `/orgs/${owner}/repos`,
        { name: repo, private: false, auto_init: true },
        token
      );
    }
    await sleep(3000); // Wait for GitHub to finish provisioning
  } else {
    // Repo exists — seed it if it has no commits
    const initialized = await repoHasCommits(owner, repo, token);
    if (!initialized) {
      await ghPut(
        `/repos/${owner}/${repo}/contents/.gitkeep`,
        {
          message: "Initialize repository",
          content: btoa(""),
          branch: defaultBranch,
        },
        token
      );
      await sleep(2000);
    }
  }

  const info = (await ghGet(`/repos/${owner}/${repo}`, token)) as Record<string, string>;
  return info.default_branch ?? defaultBranch;
}

// ── Main copy logic ─────────────────────────────────────────────────────────

type TreeItem = { path: string; type: string; sha: string; mode: string };
type NewEntry = { path: string; mode: string; type: "blob"; sha: string };

/** Copy blobs in parallel batches to stay well under rate limits. */
async function copyBlobs(
  srcOwner: string,
  srcRepo: string,
  dstOwner: string,
  dstRepo: string,
  blobs: TreeItem[],
  token: string,
  batchSize = 6
): Promise<NewEntry[]> {
  const results: NewEntry[] = [];

  for (let i = 0; i < blobs.length; i += batchSize) {
    const batch = blobs.slice(i, i + batchSize);
    const entries = await Promise.all(
      batch.map(async (item) => {
        const blob = (await ghGet(
          `/repos/${srcOwner}/${srcRepo}/git/blobs/${item.sha}`,
          token
        )) as { content: string; encoding: string };

        const newBlob = (await ghPost(
          `/repos/${dstOwner}/${dstRepo}/git/blobs`,
          { content: blob.content, encoding: blob.encoding },
          token
        )) as { sha: string };

        return {
          path: item.path,
          mode: item.mode,
          type: "blob" as const,
          sha: newBlob.sha,
        };
      })
    );
    results.push(...entries);
  }

  return results;
}

async function copyRepo(
  srcOwner: string,
  srcRepo: string,
  dstOwner: string,
  dstRepo: string,
  token: string
): Promise<void> {
  // 1. Read source metadata + tree
  const srcInfo = (await ghGet(`/repos/${srcOwner}/${srcRepo}`, token)) as Record<string, string>;
  const srcBranch: string = srcInfo.default_branch ?? "main";

  const refData = (await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/ref/heads/${srcBranch}`,
    token
  )) as { object: { sha: string } };

  const commitData = (await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/commits/${refData.object.sha}`,
    token
  )) as { tree: { sha: string } };

  const treeData = (await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/trees/${commitData.tree.sha}?recursive=1`,
    token
  )) as { tree: TreeItem[] };

  const items = treeData.tree;
  const blobItems = items.filter((i) => i.type === "blob");

  // 2. Ensure target repo exists and has at least one commit
  const dstBranch = await ensureRepoReady(dstOwner, dstRepo, srcBranch, token);

  // 3. Copy all blobs in parallel batches
  const newEntries = await copyBlobs(
    srcOwner,
    srcRepo,
    dstOwner,
    dstRepo,
    blobItems,
    token
  );

  // 4. Create tree, commit, update ref
  const newTree = (await ghPost(
    `/repos/${dstOwner}/${dstRepo}/git/trees`,
    { tree: newEntries },
    token
  )) as { sha: string };

  // Parent = current HEAD (if any)
  const refCheck = await ghFetch(
    "GET",
    `/repos/${dstOwner}/${dstRepo}/git/ref/heads/${dstBranch}`,
    token
  );
  const parentShas: string[] = refCheck.ok
    ? [(refCheck.data as { object: { sha: string } }).object.sha]
    : [];

  const newCommit = (await ghPost(
    `/repos/${dstOwner}/${dstRepo}/git/commits`,
    {
      message: `Copy from ${srcOwner}/${srcRepo}`,
      tree: newTree.sha,
      parents: parentShas,
    },
    token
  )) as { sha: string };

  if (refCheck.ok) {
    await ghPatch(
      `/repos/${dstOwner}/${dstRepo}/git/refs/heads/${dstBranch}`,
      { sha: newCommit.sha, force: true },
      token
    );
  } else {
    await ghPost(
      `/repos/${dstOwner}/${dstRepo}/git/refs`,
      { ref: `refs/heads/${dstBranch}`, sha: newCommit.sha },
      token
    );
  }
}

// ── Vercel deployment ───────────────────────────────────────────────────────

async function createVercelProject(
  dstOwner: string,
  dstRepo: string,
  vercelToken: string
): Promise<string> {
  // Use a stable name (no timestamp) so retries reuse the same project
  const projectName = dstRepo
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 52);

  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };

  // Try to create; if name is taken (409) reuse the existing project
  const createRes = await fetch("https://api.vercel.com/v9/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: projectName,
      gitRepository: { repo: `${dstOwner}/${dstRepo}`, type: "github" },
    }),
  });

  let projectName_: string;

  if (createRes.ok) {
    const p = (await createRes.json()) as { name: string };
    projectName_ = p.name;
  } else if (createRes.status === 409) {
    // Project already exists — fetch it
    const existing = await fetch(
      `https://api.vercel.com/v9/projects/${projectName}`,
      { headers }
    );
    if (!existing.ok) {
      const body = await existing.text();
      throw new Error(`Vercel get existing project failed: ${body}`);
    }
    const p = (await existing.json()) as { name: string };
    projectName_ = p.name;
  } else {
    const body = await createRes.text();
    throw new Error(`Vercel create project failed (${createRes.status}): ${body}`);
  }

  // Return the stable alias URL — no polling needed
  return `https://${projectName_}.vercel.app`;
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { sourceUrl, targetUrl } = (await req.json()) as {
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

    // Copy repo files
    await copyRepo(src.owner, src.repo, dst.owner, dst.repo, GITHUB_TOKEN);

    // Create Vercel project (returns stable URL; deployment runs in background on Vercel)
    const liveUrl = await createVercelProject(dst.owner, dst.repo, VERCEL_TOKEN);

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
