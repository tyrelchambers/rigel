// GitHub connection card — the persistent place to manage the single account-
// level PAT (rendered in the Accounts panel). Connect (with a link to create a
// token), see who's connected, or disconnect. The same PAT drives GitOps repo
// listing, clone/diff/apply, and the AI PR flow.
import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGitHubAccount, useConnectGitHub, useDisconnectGitHub } from "./gitApi";

/** Classic PAT with the `repo` scope (covers clone/push + opening PRs). */
export const GITHUB_TOKEN_URL = "https://github.com/settings/tokens/new?description=Helmsman&scopes=repo";

const inputClass =
  "flex-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-ring";

export function GitHubConnectionCard() {
  const { data: account } = useGitHubAccount();
  const connect = useConnectGitHub();
  const disconnect = useDisconnectGitHub();
  const [token, setToken] = useState("");

  if (account?.connected) {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-background px-3 py-2.5">
        <GitBranch className="size-5" style={{ color: "var(--accent-primary)" }} aria-hidden />
        <div className="min-w-0">
          <div className="text-sm font-semibold">GitHub</div>
          <div className="truncate text-xs text-muted-foreground">
            Connected as <span className="font-mono">{account.login ?? "—"}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
          Disconnect
        </Button>
      </div>
    );
  }

  async function handleConnect() {
    try {
      await connect.mutateAsync(token);
      setToken("");
    } catch {
      /* error shown below */
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-background px-3 py-2.5">
      <div className="flex items-center gap-2">
        <GitBranch className="size-5" style={{ color: "var(--accent-primary)" }} aria-hidden />
        <div className="text-sm font-semibold">GitHub</div>
        <span className="text-xs text-muted-foreground">connect to deploy from your repos (GitOps)</span>
      </div>
      <a href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer" className="inline-block text-xs hover:underline" style={{ color: "var(--accent-primary)" }}>
        Create a personal access token ↗ (classic, “repo” scope)
      </a>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={token}
          placeholder="ghp_…"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && token) handleConnect(); }}
          className={inputClass}
          spellCheck={false}
        />
        <Button size="sm" onClick={handleConnect} disabled={!token || connect.isPending}>
          {connect.isPending ? "Connecting…" : "Connect"}
        </Button>
      </div>
      {connect.isError && <p className="text-xs text-destructive">{connect.error.message}</p>}
    </div>
  );
}
