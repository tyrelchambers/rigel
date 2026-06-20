import { useMemo, useState } from "react";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { rigel } from "@/lib/desktop";
import { buildHelmInstallCommands, type HelmChartSource, type HelmRelease } from "@rigel/k8s/src/helm";
import { useArtifactHubSearch, useHelmInstall, useHelmShowValues } from "./helmApi";
import { HelmConfirmModal } from "./HelmConfirmModal";

type Mode = "repo" | "oci" | "search" | "local";

export function InstallChartView({ prefill }: { prefill: HelmRelease | null }) {
  const [mode, setMode] = useState<Mode>("repo");
  const [releaseName, setReleaseName] = useState(prefill?.name ?? "");
  const [namespace, setNamespace] = useState(prefill?.namespace ?? "default");
  const [repoName, setRepoName] = useState("");
  const [repoURL, setRepoURL] = useState("");
  const [chart, setChart] = useState(prefill?.chartName ?? "");
  const [version, setVersion] = useState("");
  const [ociRef, setOciRef] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [query, setQuery] = useState("");
  const [values, setValues] = useState("# values\n");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useArtifactHubSearch(mode === "search" ? query : "");
  const install = useHelmInstall();

  const source: HelmChartSource | null = useMemo(() => {
    if (mode === "repo") return repoName && repoURL && chart ? { kind: "repo", repoName, repoURL, chart, version: version || null } : null;
    if (mode === "oci") return ociRef ? { kind: "oci", ref: ociRef, version: version || null } : null;
    if (mode === "local") return localPath ? { kind: "local", path: localPath } : null;
    return null; // search prefills repo/oci then switches mode
  }, [mode, repoName, repoURL, chart, version, ociRef, localPath]);

  const showValuesRef = mode === "oci" ? ociRef : mode === "repo" && chart ? chart : null;
  const seeded = useHelmShowValues(showValuesRef, version || null);

  const allCommands = source && releaseName && namespace
    ? buildHelmInstallCommands(source, { releaseName, namespace, valuesFile: "values.yaml", context: null })
    : [];
  const command = allCommands[allCommands.length - 1] ?? [];

  async function pickLocal() {
    if (!rigel?.openChartFile) { setError("File picker is only available in the desktop app."); return; }
    const res = await rigel.openChartFile();
    if (!res.canceled && res.path) setLocalPath(res.path);
  }

  function submit() {
    if (!source) return;
    setError(null);
    install.mutate(
      { source, releaseName, namespace, values },
      {
        onSuccess: (r) => (r.code === 0 ? setConfirm(false) : setError(r.stderr || `exit ${r.code}`)),
        onError: (e) => setError(e.message),
      },
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex gap-2 text-sm">
        {(["repo", "oci", "search", "local"] as Mode[]).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className="rounded-md px-2.5 py-1.5" style={{ background: mode === m ? "rgba(255,255,255,0.08)" : "transparent" }}>
            {m === "repo" ? "Repo + chart" : m === "oci" ? "OCI ref" : m === "search" ? "Artifact Hub" : "Local file"}
          </button>
        ))}
      </div>

      {mode === "repo" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Repo name" value={repoName} onChange={setRepoName} />
          <Field label="Repo URL" value={repoURL} onChange={setRepoURL} />
          <Field label="Chart" value={chart} onChange={setChart} />
          <Field label="Version (optional)" value={version} onChange={setVersion} />
        </div>
      )}
      {mode === "oci" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="OCI ref (oci://…)" value={ociRef} onChange={setOciRef} />
          <Field label="Version (optional)" value={version} onChange={setVersion} />
        </div>
      )}
      {mode === "local" && (
        <div className="flex items-end gap-2">
          <Field label="Chart path (.tgz or folder)" value={localPath} onChange={setLocalPath} />
          <button type="button" className="rounded-md px-3 py-2 text-sm hover:bg-white/[0.05]" onClick={pickLocal}>Browse…</button>
        </div>
      )}
      {mode === "search" && (
        <div>
          <Field label="Search Artifact Hub" value={query} onChange={setQuery} />
          <ul className="mt-2 space-y-1">
            {(search.data ?? []).map((c, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
                  onClick={() => {
                    if (c.source.kind === "oci") { setMode("oci"); setOciRef(c.source.ref); }
                    else if (c.source.kind === "repo") { setMode("repo"); setRepoName(c.source.repoName); setRepoURL(c.source.repoURL); setChart(c.source.chart); }
                    setVersion(c.version);
                    if (!releaseName) setReleaseName(c.name);
                  }}
                >
                  <span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{c.repoName} · {c.version}</span>
                  <div className="text-xs text-muted-foreground">{c.description}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Release name" value={releaseName} onChange={setReleaseName} />
        <Field label="Namespace" value={namespace} onChange={setNamespace} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Values</span>
          {showValuesRef && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => seeded.data?.code === 0 && setValues(seeded.data.stdout)}>
              Load defaults
            </button>
          )}
        </div>
        <YamlEditor value={values} onChange={setValues} height="280px" schema={null} />
      </div>

      <div className="flex justify-end">
        <button type="button" disabled={!source || !releaseName || !namespace} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" onClick={() => { setError(null); setConfirm(true); }}>
          Install
        </button>
      </div>

      <HelmConfirmModal
        open={confirm}
        onOpenChange={(o) => { if (!o) setConfirm(false); }}
        title={`Install ${releaseName || "release"}?`}
        command={command}
        running={install.isPending}
        error={error}
        onConfirm={submit}
      />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <input className="w-full rounded-md border bg-transparent px-2.5 py-1.5" style={{ borderColor: "var(--border-strong)" }} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
