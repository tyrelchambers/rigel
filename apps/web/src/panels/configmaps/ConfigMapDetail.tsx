import { useState, type ComponentType } from "react";
import {
  Calendar,
  Check,
  Copy,
  Download,
  FileArchive,
  FileCode,
  FileKey,
  FileText,
  Pencil,
  Trash2,
} from "lucide-react";
import { MetaCard, SectionLabel } from "@/panels/components/MetaCard";
import { KindBadge } from "./KindBadge";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { useCopyToClipboard } from "@/lib/useCopyToClipboard";
import { downloadText } from "@/lib/download";
import { fetchResourceYaml, type ActionBlock } from "@/lib/api";
import type { ConfigMap } from "./types";
import {
  keyCount,
  keysSorted,
  isBinaryKey,
  plaintextBytes,
  binaryBytes,
  humanAge,
  humanBytes,
  valueKind,
  kindLabel,
  valueLines,
  namespaceDotColor,
  type ValueKind,
} from "./configmapsDisplay";

// ---------------------------------------------------------------------------
// Expanded row body — Pencil frame xCFK3 ("ConfigMaps — expanded row
// (improved)"). Renders inside the shared ListRow expanded wrapper, which
// already provides the surrounding padding + background. Three sections:
// meta strip (KEYS/AGE/NAMESPACE), per-key code-preview cards, and a Manage bar.
// ---------------------------------------------------------------------------

export function ConfigMapDetail({
  configMap,
  onEdit,
}: {
  configMap: ConfigMap;
  onEdit: () => void;
}) {
  const name = configMap.metadata.name;
  const namespace = configMap.metadata.namespace;
  const keys = keysSorted(configMap);
  const total = keyCount(configMap);

  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [busy, setBusy] = useState<null | "download" | "copy">(null);
  const [err, setErr] = useState<string | null>(null);
  const { copied: yamlCopied, copy: copyText } = useCopyToClipboard();

  async function withYaml(run: (yaml: string) => void, which: "download" | "copy") {
    setErr(null);
    setBusy(which);
    try {
      run(await fetchResourceYaml("configmap", name, namespace));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Meta strip: KEYS / AGE / NAMESPACE */}
      <div className="flex gap-3">
        <MetaCard label="KEYS">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[18px] font-bold leading-none text-foreground">{total}</span>
            <span className="text-[13px] text-[var(--fg-tertiary)]">{total === 1 ? "key" : "keys"}</span>
          </div>
        </MetaCard>

        <MetaCard label="AGE">
          <div className="flex items-center gap-[7px]">
            <Calendar className="size-[13px] text-[var(--fg-tertiary)]" />
            <span className="text-[14px] text-[var(--fg-secondary)]">
              {humanAge(configMap.metadata.creationTimestamp)}
            </span>
          </div>
        </MetaCard>

        <MetaCard label="NAMESPACE">
          <div className="flex items-center gap-2">
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: namespaceDotColor(namespace ?? "—") }}
              aria-hidden
            />
            <span className="font-mono text-[13px] text-[var(--fg-secondary)]">{namespace ?? "—"}</span>
          </div>
        </MetaCard>
      </div>

      {/* Keys */}
      <div className="flex flex-col gap-[9px]">
        <SectionLabel>{`KEYS · ${total}`}</SectionLabel>
        {keys.length === 0 ? (
          <p className="text-xs text-[var(--fg-tertiary)]">No data keys</p>
        ) : (
          keys.map((key) => <KeyCard key={key} configMap={configMap} keyName={key} />)
        )}
      </div>

      {/* Manage */}
      <div className="flex items-center gap-3 border-t pt-4 border-[var(--border-subtle)]">
        <SectionLabel>MANAGE</SectionLabel>
        <ManageButton tone="accent" icon={Pencil} onClick={onEdit}>
          Edit
        </ManageButton>
        <ManageButton
          icon={Download}
          disabled={busy !== null}
          onClick={() => void withYaml((yaml) => downloadText(`${name}.yaml`, yaml), "download")}
        >
          {busy === "download" ? "Downloading…" : "Download YAML"}
        </ManageButton>
        <ManageButton
          icon={yamlCopied ? Check : Copy}
          disabled={busy !== null}
          onClick={() => void withYaml((yaml) => copyText(yaml), "copy")}
        >
          {yamlCopied ? "Copied" : busy === "copy" ? "Copying…" : "Copy"}
        </ManageButton>
        <span className="flex-1" />
        <ManageButton
          tone="danger"
          icon={Trash2}
          onClick={() =>
            setPendingAction({
              kind: "deleteResource",
              resourceKind: "configmap",
              name,
              namespace,
              destructive: true,
              label: `Delete ${name}`,
            })
          }
        >
          Delete
        </ManageButton>
      </div>
      {err && <p className="font-mono text-[11px] text-[var(--status-failed)]">{err}</p>}

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-key code-preview card.
// ---------------------------------------------------------------------------

const KIND_ICON: Record<ValueKind, ComponentType<{ className?: string }>> = {
  certificate: FileKey,
  json: FileCode,
  yaml: FileCode,
  text: FileText,
};

function KeyCard({ configMap, keyName }: { configMap: ConfigMap; keyName: string }) {
  const binary = isBinaryKey(configMap, keyName);
  const { copied, copy } = useCopyToClipboard();

  if (binary) {
    const bytes = binaryBytes(configMap.binaryData?.[keyName] ?? "");
    return (
      <div className="overflow-hidden rounded-md border bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
        <KeyHeader icon={FileArchive} name={keyName} bytes={bytes} badge={<KindBadge kind="binary" />} />
        <div className="bg-[var(--surface-sunken)] px-[16px] py-[14px]">
          <span className="font-mono text-[12.5px] text-[var(--fg-tertiary)]">{`<binary data · ${humanBytes(bytes)}>`}</span>
        </div>
        <KeyFooter left={`BINARY · ${humanBytes(bytes)}`} />
      </div>
    );
  }

  const value = configMap.data?.[keyName] ?? "";
  const bytes = plaintextBytes(value);
  const kind = valueKind(keyName, value);
  const lines = valueLines(value);

  return (
    <div className="overflow-hidden rounded-md border bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
      <KeyHeader
        icon={KIND_ICON[kind]}
        name={keyName}
        bytes={bytes}
        badge={<KindBadge kind={kind} />}
        copy={
          <button
            type="button"
            onClick={() => copy(value)}
            className="inline-flex items-center gap-[6px] rounded-sm bg-white/[0.05] px-[10px] py-[5px] text-[var(--fg-secondary)] transition-colors hover:text-foreground"
          >
            {copied ? (
              <Check className="size-[13px] text-[var(--status-running)]" />
            ) : (
              <Copy className="size-[13px]" />
            )}
            <span className="text-[12px]">{copied ? "Copied" : "Copy"}</span>
          </button>
        }
      />

      {/* Scrollable numbered code block */}
      <div className="max-h-[320px] overflow-auto bg-[var(--surface-sunken)]">
        <div className="flex w-max min-w-full flex-col gap-[3px] px-[16px] py-[14px]">
          {lines.map((line, i) => {
            const pem = line.includes("-----BEGIN") || line.includes("-----END");
            return (
              <div key={i} className="flex items-center gap-[14px]">
                <span className="w-[22px] shrink-0 text-right font-mono text-[11.5px] text-[var(--fg-tertiary)]">
                  {i + 1}
                </span>
                <span
                  className={`select-text whitespace-pre font-mono text-[12.5px] ${
                    pem ? "font-semibold text-[var(--accent-primary)]" : "text-[var(--fg-secondary)]"
                  }`}
                >
                  {line === "" ? " " : line}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <KeyFooter left={`${kindLabel(kind)} · ${humanBytes(bytes)}`} right={`${lines.length} ${lines.length === 1 ? "line" : "lines"}`} />
    </div>
  );
}

function KeyHeader({
  icon: Icon,
  name,
  bytes,
  badge,
  copy,
}: {
  icon: ComponentType<{ className?: string }>;
  name: string;
  bytes: number;
  badge: React.ReactNode;
  copy?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-[9px] border-b px-[14px] py-[10px] bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
      <Icon className="size-[15px] text-[var(--fg-secondary)]" />
      <span className="select-text font-mono text-[13.5px] font-semibold text-foreground">{name}</span>
      <span className="rounded-sm bg-white/[0.05] px-[7px] py-[2px] font-mono text-[11px] text-[var(--fg-tertiary)]">
        {humanBytes(bytes)}
      </span>
      {badge}
      <span className="flex-1" />
      {copy}
    </div>
  );
}

function KeyFooter({ left, right }: { left: string; right?: string }) {
  return (
    <div className="flex items-center justify-between border-t px-[14px] py-[8px] bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
      <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{left}</span>
      {right && <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{right}</span>}
    </div>
  );
}

function ManageButton({
  tone = "neutral",
  icon: Icon,
  children,
  onClick,
  disabled,
}: {
  tone?: "neutral" | "accent" | "danger";
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const toneClass =
    tone === "accent"
      ? "bg-[var(--accent-primary)]/[0.12] border-[var(--accent-primary)]/30 text-[var(--accent-primary)]"
      : tone === "danger"
        ? "bg-[var(--status-failed)]/10 border-[var(--status-failed)]/25 text-[var(--status-failed)]"
        : "bg-[var(--surface-elevated)] border-[var(--border-subtle)] text-[var(--fg-secondary)] hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-[7px] rounded-md border px-[14px] py-[8px] text-[13px] font-semibold transition-colors disabled:opacity-60 ${toneClass}`}
    >
      <Icon className="size-[14px]" aria-hidden />
      {children}
    </button>
  );
}
