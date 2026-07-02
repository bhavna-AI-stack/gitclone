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

async function ghGet(path: string, token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GET ${path} failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghPost(path: string, body: unknown, token: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub POST ${path} failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function copyRepo(
  srcOwner: string,
  srcRepo: string,
  dstOwner: string,
  dstRepo: string,
  token: string
): Promise<void> {
  // Get source repo default branch
  const srcInfo = await ghGet(`/repos/${srcOwner}/${srcRepo}`, token);
  const defaultBranch: string = srcInfo.default_branch ?? "main";

  // Get latest commit SHA on default branch
  const refData = await ghGet(`/repos/${srcOwner}/${srcRepo}/git/ref/heads/${defaultBranch}`, token);
  const commitSha: string = refData.object.sha;

  // Get commit to find tree SHA
  const commitData = await ghGet(`/repos/${srcOwner}/${srcRepo}/git/commits/${commitSha}`, token);
  const treeSha: string = commitData.tree.sha;

  // Get full recursive tree
  const treeData = await ghGet(
    `/repos/${srcOwner}/${srcRepo}/git/trees/${treeSha}?recursive=1`,
    token
  );
  const items: Array<{ path: string; type: string; sha: string; mode: string }> = treeData.tree;

  // Check if target repo already exists; create if not
  try {
    await ghGet(`/repos/${dstOwner}/${dstRepo}`, token);
  } catch {
    // Repo doesn't exist — create it
    // Try user repo first, then org
    try {
      await ghPost(`/user/repos`, { name: dstRepo, private: false, auto_init: false }, token);
    } catch {
      await ghPost(`/orgs/${dstOwner}/repos`, { name: dstRepo, private: false, auto_init: false }, token);
    }
    // Give GitHub a moment to provision
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Build new tree entries — copy blobs from source into destination
  const newTreeEntries: Array<{ path: string; mode: string; type: string; sha?: string; content?: string }> = [];

  for (const item of items) {
    if (item.type === "blob") {
      // Fetch blob content from source
      const blob = await ghGet(`/repos/${srcOwner}/${srcRepo}/git/blobs/${item.sha}`, token);
      // Create blob in destination
      const newBlob = await ghPost(
        `/repos/${dstOwner}/${dstRepo}/git/blobs`,
        { content: blob.content, encoding: blob.encoding },
        token
      );
      newTreeEntries.push({
        path: item.path,
        mode: item.mode as string,
        type: "blob",
        sha: newBlob.sha,
      });
    } else if (item.type === "tree") {
      newTreeEntries.push({ path: item.path, mode: item.mode as string, type: "tree", sha: item.sha });
    }
  }

  // Create new tree in destination
  const newTree = await ghPost(`/repos/${dstOwner}/${dstRepo}/git/trees`, { tree: newTreeEntries }, token);

  // Create commit in destination
  let parentShas: string[] = [];
  try {
    const dstRef = await ghGet(`/repos/${dstOwner}/${dstRepo}/git/ref/heads/${defaultBranch}`, token);
    parentShas = [dstRef.object.sha];
  } catch {
    // No commits yet — orphan commit
  }

  const newCommit = await ghPost(`/repos/${dstOwner}/${dstRepo}/git/commits`, {
    message: `Copy from ${srcOwner}/${srcRepo}`,
    tree: newTree.sha,
    parents: parentShas,
  }, token);

  // Update or create branch reference
  try {
    await ghGet(`/repos/${dstOwner}/${dstRepo}/git/ref/heads/${defaultBranch}`, token);
    // Reference exists — force update
    const res = await fetch(
      `https://api.github.com/repos/${dstOwner}/${dstRepo}/git/refs/heads/${defaultBranch}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ sha: newCommit.sha, force: true }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`PATCH ref failed ${res.status}: ${t}`);
    }
  } catch {
    // Reference doesn't exist — create it
    await ghPost(`/repos/${dstOwner}/${dstRepo}/git/refs`, {
      ref: `refs/heads/${defaultBranch}`,
      sha: newCommit.sha,
    }, token);
  }
}

async function deployToVercel(
  dstOwner: string,
  dstRepo: string,
  vercelToken: string
): Promise<string> {
  const projectName = `${dstRepo}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Create Vercel project linked to GitHub repo
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

  const project = await createRes.json();
  if (!createRes.ok) throw new Error(`Vercel create project failed: ${JSON.stringify(project)}`);

  const projectId: string = project.id;

  // Poll for the first deployment
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const deplRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=1`,
      { headers: { Authorization: `Bearer ${vercelToken}` } }
    );
    const deplData = await deplRes.json();
    const deployments: Array<{ state: string; url: string }> = deplData.deployments ?? [];
    if (deployments.length > 0) {
      const d = deployments[0];
      if (d.state === "READY") return `https://${d.url}`;
      if (d.state === "ERROR" || d.state === "CANCELED") throw new Error(`Vercel deployment ${d.state}`);
    }
  }

  // Return project URL even if deploy isn't done yet
  return `https://${projectName}.vercel.app`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { sourceUrl, targetUrl } = await req.json();

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

    const token = GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not configured");
    if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN not configured");

    // Step 1: Copy repository
    await copyRepo(src.owner, src.repo, dst.owner, dst.repo, token);

    // Step 2: Deploy to Vercel
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
