// Lazy 1-level folder browser — click a folder to descend, breadcrumb to go up.
// The current folder IS the chosen manifest path ("." = repo root).
import { Folder, FileText } from "lucide-react";
import { useRepoTree } from "./gitApi";

export function RepoPathBrowser({ repo, branch, value, onChange }: { repo: string; branch: string; value: string; onChange: (path: string) => void }) {
  const apiPath = value === "." ? "" : value;
  const { data: entries, isLoading, isError } = useRepoTree(repo, branch, apiPath, true);
  const segments = apiPath ? apiPath.split("/") : [];
  const dirs = (entries ?? []).filter((e) => e.type === "dir");
  const files = (entries ?? []).filter((e) => e.type === "file");

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--fg-secondary)" }}>Manifest folder</span>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button type="button" onClick={() => onChange(".")} className="hover:underline" style={{ color: apiPath === "" ? "var(--fg-primary)" : "var(--accent-primary)" }}>root</button>
        {segments.map((seg, i) => {
          const p = segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={p} className="flex items-center gap-1">
              <span style={{ color: "var(--fg-tertiary)" }}>/</span>
              <button type="button" onClick={() => onChange(p)} className="font-mono hover:underline" style={{ color: isLast ? "var(--fg-primary)" : "var(--accent-primary)" }}>{seg}</button>
            </span>
          );
        })}
      </div>
      <div className="max-h-44 overflow-auto rounded-lg" style={{ background: "#08080A", border: "1px solid #26272B" }}>
        {isLoading && <div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>}
        {isError && <div className="px-2.5 py-2 text-xs text-destructive">Couldn't read this folder.</div>}
        {!isLoading && !isError && dirs.length === 0 && files.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-muted-foreground">Empty folder.</div>
        )}
        {dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => onChange(d.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-white/[0.04]">
            <Folder className="size-3.5 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <span className="font-mono">{d.name}/</span>
          </button>
        ))}
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]" style={{ color: "var(--fg-tertiary)" }}>
            <FileText className="size-3.5 shrink-0" />
            <span className="font-mono">{f.name}</span>
          </div>
        ))}
      </div>
      <span className="text-[11px]" style={{ color: "var(--fg-tertiary)" }}>
        Deploys from <span className="font-mono text-foreground/90">{value}</span>
        {files.length > 0 ? ` · ${files.length} file${files.length === 1 ? "" : "s"} here` : ""}
      </span>
    </div>
  );
}
