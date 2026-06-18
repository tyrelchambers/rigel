import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Plus, Pencil } from "lucide-react";
import type { Secret } from "@helmsman/k8s";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { viewYaml } from "@/store/yamlViewer";
import { SecretEditor } from "./SecretEditor";
import {
  relativeAge,
  keyCount,
  keysSorted,
  secretTypeDisplayName,
  decoded,
  rawBytes,
  matchesSearch,
  sortSecrets,
} from "./secretsDisplay";

// ---------------------------------------------------------------------------
// CREATE + EDIT are implemented via SecretEditor → POST /api/apply
// (`kubectl apply -f -`); see docs/parity/configmap-secret-edit.md. Plaintext
// values are base64-encoded into the manifest; binary values are read-only on
// edit. The watch auto-refreshes after a successful apply. Reveal is purely
// client-side base64 decoding; values are never searched.
// ---------------------------------------------------------------------------

/** "0 keys" / "1 key" / "N keys" with correct pluralization. */
function keysLabel(n: number): string {
  return `${n} ${n === 1 ? "key" : "keys"}`;
}

export default function SecretsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const focusRequest = useCluster((s) => s.focusRequest);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Deep link: /secrets?q=<name> (e.g. from the Settings AI section) seeds the
  // search and shows all namespaces so the target secret is findable.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      setSearch(q);
      setNamespaceFilter(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Editor sheet: `editorOpen` true; `editTarget` null = create, else edit.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Secret | null>(null);

  function openCreate() {
    setEditTarget(null);
    setEditorOpen(true);
  }
  function openEdit(secret: Secret) {
    setEditTarget(secret);
    setEditorOpen(true);
  }

  // Subscribe to the secrets watch for the active namespace (or all).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("secrets", ns);
    return () => unsubscribe("secrets", ns);
  }, [namespaceFilter]);

  const allSecrets = useMemo(
    () =>
      sortSecrets(
        Object.values((resources["secrets"] ?? {}) as Record<string, Secret>),
      ),
    [resources],
  );
  const filtered = useMemo(
    () => allSecrets.filter((s) => matchesSearch(s, search)),
    [allSecrets, search],
  );

  // Cmd-K focus: open the editor for a secret picked in the command palette.
  useEffect(() => {
    if (focusRequest?.kind !== "secret") return;
    const match = allSecrets.find(
      (s) => s.metadata.uid === focusRequest.key || s.metadata.name === focusRequest.key,
    );
    if (!match) return; // not streamed yet; effect re-runs when allSecrets updates
    openEdit(match);
    setFocusRequest(null);
  }, [focusRequest, allSecrets]);

  // Drop a stale secret focus request if we leave before it resolves.
  useEffect(() => {
    return () => {
      if (useCluster.getState().focusRequest?.kind === "secret") {
        useCluster.getState().setFocusRequest(null);
      }
    };
  }, []);

  const shown = filtered.length;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function askClaude(secret: Secret, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(
      buildHandoffPrompt("secret", secret.metadata.name, secret.metadata.namespace, topic),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Secrets"
        subtitle="Encrypted key/value pairs"
        count={shown}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search secrets…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" aria-hidden /> New Secret
        </Button>
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {/* Error banner */}
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        {/* Row list */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
        {filtered.map((secret) => {
          const uid = secret.metadata.uid;
          const isOpen = expanded.has(uid);
          const displayType = secretTypeDisplayName(secret.type);
          const rawType = secret.type ?? "Opaque";
          const keys = keyCount(secret);
          const rowMenu = (
            <>
              <ContextMenuItem onClick={() => askClaude(secret, "Errors")}>Ask Claude: Errors</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(secret, "Logs")}>Ask Claude: Logs</ContextMenuItem>
              <ContextMenuItem onClick={() => askClaude(secret, "Explain")}>Ask Claude: Explain</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => openEdit(secret)}>Edit…</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => viewYaml("secret", secret.metadata.name, secret.metadata.namespace)}>View YAML…</ContextMenuItem>
              <ContextMenuItem onClick={() => toggleExpand(uid)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={uid}
              rowKey={uid}
              isOpen={isOpen}
              onToggle={() => toggleExpand(uid)}
              contextMenu={rowMenu}
              expandedContent={
                <SecretDetail secret={secret} onEdit={() => openEdit(secret)} />
              }
            >
              {/* Name */}
              <button
                type="button"
                onClick={() => toggleExpand(uid)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
              >
                {secret.metadata.name}
              </button>

              {/* Namespace chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  background: "var(--surface-sunken)",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #26272B",
                  whiteSpace: "nowrap",
                }}
              >
                {secret.metadata.namespace ?? "—"}
              </span>

              {/* Secret type — purple TagPill */}
              <TagPill label={displayType} title={rawType} />

              {/* Key count — neutral badge */}
              <StatusBadge label={keysLabel(keys)} variant="neutral" />

              {/* Spacer */}
              <span className="flex-1" />

              {/* Age — dim */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  whiteSpace: "nowrap",
                }}
              >
                {relativeAge(secret.metadata.creationTimestamp)}
              </span>

              {/* Action button strip — Errors / Logs / Explain + Edit */}
              <ActionButtonStrip
                onErrors={(e) => { e.stopPropagation(); askClaude(secret, "Errors"); }}
                onLogs={(e) => { e.stopPropagation(); askClaude(secret, "Logs"); }}
                onExplain={(e) => { e.stopPropagation(); askClaude(secret, "Explain"); }}
                extra={[
                  {
                    label: "Edit",
                    Icon: Pencil,
                    onClick: (e) => { e.stopPropagation(); openEdit(secret); },
                  },
                ]}
              />
            </ListRow>
          );
        })}
      </div>

        {/* Empty / filtered-to-zero states */}
        {!isLoading && allSecrets.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No secrets found</p>
        )}
        {!isLoading && allSecrets.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No secrets match search</p>
        )}
      </div>

      <SecretEditor
        target={editTarget}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onApplied={() => setEditorOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail: STATUS summary + KEYS section (sorted, reveal toggles).
// ---------------------------------------------------------------------------

/** Expanded detail: STATUS summary + KEYS section (sorted, reveal toggles). */
function SecretDetail({ secret, onEdit }: { secret: Secret; onEdit: () => void }) {
  const keys = keysSorted(secret);
  const total = keyCount(secret);
  const displayType = secretTypeDisplayName(secret.type);
  const rawType = secret.type ?? "Opaque";
  const labelEntries = Object.entries(secret.metadata.labels ?? {});

  // Per-key reveal state (Set of revealed key names). Local, not persisted.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* STATUS */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Status
        </h3>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
          <dt className="text-muted-foreground">TYPE</dt>
          <dd>{displayType}</dd>
          <dt className="text-muted-foreground">RAW TYPE</dt>
          <dd className="break-all">{rawType}</dd>
          <dt className="text-muted-foreground">KEYS</dt>
          <dd>{total}</dd>
          <dt className="text-muted-foreground">AGE</dt>
          <dd>{relativeAge(secret.metadata.creationTimestamp)}</dd>
          {labelEntries.length > 0 && (
            <>
              <dt className="text-muted-foreground">LABELS</dt>
              <dd className="break-all">
                {labelEntries.map(([k, v]) => `${k}=${v}`).join(", ")}
              </dd>
            </>
          )}
        </dl>
      </div>

      {/* KEYS */}
      <div className="space-y-1">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Keys ({total})
        </h3>
        {keys.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">No data keys</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => {
              const bytes = rawBytes(secret, key);
              const isRevealed = revealed.has(key);
              const value = isRevealed ? decoded(secret, key) : null;
              return (
                <li key={key} className="rounded-md border bg-background/40 p-2">
                  <div className="flex items-center gap-2">
                    <span className="select-text font-mono text-xs">{key}</span>
                    <span className="font-mono text-xs text-muted-foreground">{bytes}B</span>
                    <button
                      type="button"
                      onClick={() => toggleReveal(key)}
                      aria-pressed={isRevealed}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {isRevealed ? (
                        <>
                          <EyeOff className="size-3" aria-hidden /> Hide
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" aria-hidden /> Reveal
                        </>
                      )}
                    </button>
                  </div>
                  {isRevealed ? (
                    value == null ? (
                      <p className="mt-1 select-text rounded-md border p-2 text-xs font-mono text-muted-foreground/70">
                        {`<binary, ${bytes} bytes>`}
                      </p>
                    ) : (
                      <pre className="mt-1 max-h-[200px] select-text overflow-auto rounded-md border p-2 text-xs font-mono text-muted-foreground/80 whitespace-pre-wrap break-all">
                        {value}
                      </pre>
                    )
                  ) : (
                    <p className="mt-1 select-none p-2 text-xs font-mono tracking-widest text-muted-foreground/60">
                      ••••••••
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Edit button */}
      <div
        className="flex items-center gap-2 border-t pt-3"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mr-2">
          Manage
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onEdit}>
          <Pencil className="size-3" />
          Edit
        </Button>
      </div>
    </div>
  );
}
