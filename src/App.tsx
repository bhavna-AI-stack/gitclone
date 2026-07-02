import { useState } from "react";
import { Github, Rocket, CheckCircle, AlertCircle, Loader2, ExternalLink, Copy } from "lucide-react";

type Status = "idle" | "copying" | "deploying" | "done" | "error";

interface Result {
  copiedRepo: string;
  liveUrl: string;
}

export default function App() {
  const [sourceUrl, setSourceUrl] = useState("https://github.com/Krrish41/space-cargo-runner");
  const [targetUrl, setTargetUrl] = useState("https://github.com/bhavna-AI-stack/space-cargo");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit() {
    if (!sourceUrl.trim() || !targetUrl.trim()) return;
    setStatus("copying");
    setError(null);
    setResult(null);

    try {
      setStatus("copying");
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/repo-copier`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sourceUrl: sourceUrl.trim(), targetUrl: targetUrl.trim() }),
        }
      );

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      setResult({ copiedRepo: data.copiedRepo, liveUrl: data.liveUrl });
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isLoading = status === "copying" || status === "deploying";

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col items-center justify-center px-4">
      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="relative z-10 w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
              <Github className="w-6 h-6 text-white" />
            </div>
            <span className="text-white/40 text-xl">→</span>
            <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
              <Rocket className="w-6 h-6 text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Repo Copy & Deploy</h1>
          <p className="mt-2 text-white/50 text-sm">
            Copy a GitHub repository to another account and deploy it live on Vercel.
          </p>
        </div>

        {/* Card */}
        <div className="bg-[#161b22] border border-white/10 rounded-2xl p-6 shadow-2xl">
          {/* Source URL */}
          <div className="mb-5">
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-widest mb-2">
              GitHub URL 1 <span className="text-white/30 normal-case">(source)</span>
            </label>
            <div className="relative">
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                disabled={isLoading}
                placeholder="https://github.com/owner/repo"
                className="w-full bg-[#0d1117] border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition disabled:opacity-50"
              />
            </div>
          </div>

          {/* Target URL */}
          <div className="mb-6">
            <label className="block text-xs font-semibold text-white/60 uppercase tracking-widest mb-2">
              GitHub URL 2 <span className="text-white/30 normal-case">(target account/repo)</span>
            </label>
            <div className="relative">
              <input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                disabled={isLoading}
                placeholder="https://github.com/target-owner/new-repo"
                className="w-full bg-[#0d1117] border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 transition disabled:opacity-50"
              />
            </div>
            <p className="mt-2 text-xs text-white/30">
              A brand new repo will be created in the target account with this name.
            </p>
          </div>

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || !sourceUrl.trim() || !targetUrl.trim()}
            className="w-full flex items-center justify-center gap-2.5 py-3.5 px-6 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: isLoading
                ? "linear-gradient(135deg, #7c3aed, #a855f7)"
                : "linear-gradient(135deg, #7c3aed, #a855f7)",
              boxShadow: isLoading ? "none" : "0 0 24px rgba(168, 85, 247, 0.35)",
            }}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {status === "copying" ? "Copying repository…" : "Deploying to Vercel…"}
              </>
            ) : (
              <>
                <Rocket className="w-4 h-4" />
                Submit — copy &amp; deploy
              </>
            )}
          </button>

          {/* Progress Steps */}
          {isLoading && (
            <div className="mt-5 space-y-2">
              <Step active={status === "copying"} done={false} label="Cloning source repository & pushing to target" />
              <Step active={status === "deploying"} done={false} label="Deploying to Vercel" />
            </div>
          )}

          {/* Success */}
          {status === "done" && result && (
            <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-sm font-semibold text-emerald-400">Done! Repo copied & deployed</span>
              </div>
              <ResultRow
                label="GitHub Repo"
                url={result.copiedRepo}
                onCopy={() => copyUrl(result.copiedRepo)}
              />
              <ResultRow
                label="Live URL"
                url={result.liveUrl}
                onCopy={() => copyUrl(result.liveUrl)}
                highlight
              />
              {copied && (
                <p className="text-xs text-white/40 mt-2 text-right">Copied to clipboard!</p>
              )}
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <div className="mt-5 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-400 mb-1">Something went wrong</p>
                  <p className="text-xs text-red-300/70 break-all">{error}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-white/20 mt-6">
          Powered by GitHub API + Vercel API
        </p>
      </div>
    </div>
  );
}

function Step({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2.5 text-xs transition-opacity ${active ? "opacity-100" : "opacity-40"}`}>
      {done ? (
        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
      ) : active ? (
        <Loader2 className="w-3.5 h-3.5 text-purple-400 animate-spin shrink-0" />
      ) : (
        <div className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0" />
      )}
      <span className={active ? "text-white/80" : "text-white/40"}>{label}</span>
    </div>
  );
}

function ResultRow({
  label,
  url,
  onCopy,
  highlight,
}: {
  label: string;
  url: string;
  onCopy: () => void;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2 last:mb-0">
      <span className="text-xs text-white/40 w-20 shrink-0">{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs truncate flex-1 hover:underline ${highlight ? "text-emerald-400" : "text-white/70"}`}
      >
        {url}
      </a>
      <div className="flex items-center gap-1">
        <button
          onClick={onCopy}
          className="p-1 rounded hover:bg-white/10 transition text-white/40 hover:text-white/80"
        >
          <Copy className="w-3 h-3" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded hover:bg-white/10 transition text-white/40 hover:text-white/80"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
