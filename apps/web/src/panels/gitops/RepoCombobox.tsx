// Searchable repo list — type to filter, click to pick (client-side over the
// already-fetched repos).
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { GithubRepo } from "./gitApi";

export function RepoCombobox({ repos, value, onChange, error }: { repos: GithubRepo[]; value: string; onChange: (fullName: string) => void; error: string | null }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos;
    return list.slice(0, 60);
  }, [repos, q]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>Repository</span>
      <input
        type="text"
        value={q}
        placeholder="Search your repositories…"
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        spellCheck={false}
        style={{ padding: "8px 10px", borderRadius: 8, background: "#08080A", border: "1px solid #26272B", color: "var(--fg-primary)", fontSize: 13, outline: "none" }}
      />
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        <ul className="max-h-44 overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
          {filtered.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">No matching repositories.</li>}
          {filtered.map((r) => {
            const sel = r.fullName === value;
            return (
              <li key={r.fullName}>
                <button
                  type="button"
                  onClick={() => onChange(r.fullName)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[13px] hover:bg-white/[0.04]"
                  style={sel ? { background: "var(--accent-primary)22" } : undefined}
                >
                  {sel ? <Check className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} /> : <span className="w-3.5 shrink-0" />}
                  <span className="truncate">{r.fullName}</span>
                  {r.private && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">private</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </label>
  );
}
