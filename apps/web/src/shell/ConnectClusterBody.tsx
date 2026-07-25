import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLock, faUpload } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { listCloudProviders, type ProviderDescriptor } from "@rigel/cloud-connect/src/index";
import { ClusterIcon } from "./clusterIcons";
import { ConnectWizard } from "./ConnectWizard";
import { ImportKubeconfigPanel } from "./ImportKubeconfigPanel";
import { useEntitlement } from "./useEntitlement";
import { useUpgrade } from "./UpgradeContext";

type Selection = { kind: "provider"; descriptor: ProviderDescriptor } | { kind: "import" } | null;

export const CONNECT_CLUSTER_TITLE = "Connect a cluster";

function titleFor(s: Selection): string {
  return s?.kind === "provider" ? `Connect to ${s.descriptor.displayName}`
    : s?.kind === "import" ? "Import a kubeconfig"
    : CONNECT_CLUSTER_TITLE;
}

function ProviderTile({
  label, icon, disabled, locked, onClick,
}: { label: string; icon: React.ReactNode; disabled?: boolean; locked?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "16px 10px",
        borderRadius: 10, cursor: disabled ? "default" : "pointer", opacity: disabled || locked ? 0.5 : 1,
        background: "var(--surface-primary)", border: "1px solid var(--border-strong)", color: "var(--fg-primary)",
      }}
    >
      {locked ? (
        <span
          aria-hidden
          style={{
            position: "absolute", top: 8, right: 8,
            width: 18, height: 18, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--surface-elevated)", border: "1px solid var(--border-strong)",
          }}
        >
          <FontAwesomeIcon icon={faLock} className="size-[11px]" style={{ color: "var(--fg-secondary)" }} />
        </span>
      ) : null}
      {icon}
      <span className="text-xs" style={{ fontWeight: 600 }}>{label}</span>
      {disabled ? (
        <span className="text-3xs" style={{ color: "var(--fg-tertiary)" }}>Coming soon</span>
      ) : locked ? (
        <span className="text-3xs" style={{ color: "var(--accent-primary)" }}>Pro</span>
      ) : null}
    </button>
  );
}

export interface ConnectClusterBodyProps {
  /** Reset the flow when the host (re)opens it. */
  active: boolean;
  /** Called when the flow finishes or the user backs out; the host closes itself. */
  onDone: () => void;
  /** Called as the flow moves between steps, so a host can title itself. */
  onTitleChange?: (title: string) => void;
}

export function ConnectClusterBody({ active, onDone, onTitleChange }: ConnectClusterBodyProps) {
  const [selection, setSelection] = useState<Selection>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; });

  const select = useCallback((next: Selection) => {
    setSelection(next);
    onTitleChangeRef.current?.(titleFor(next));
  }, []);

  useEffect(() => { if (active) select(null); }, [active, select]);

  const { payload } = useEntitlement();
  const cloudUnlocked = !!payload?.cloudConnect;
  const { openUpgrade } = useUpgrade();

  const providers = listCloudProviders();

  return selection === null ? (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      {providers.map((d) => {
        return (
          <ProviderTile
            key={d.id}
            label={d.displayName}
            icon={<ClusterIcon id={d.id} className="size-[26px]" />}
            locked={!cloudUnlocked}
            onClick={() => {
              if (!cloudUnlocked) { onDone(); openUpgrade(); }
              else select({ kind: "provider", descriptor: d });
            }}
          />
        );
      })}
      <ProviderTile label="Import a kubeconfig" icon={<FontAwesomeIcon icon={faUpload} className="size-[26px]" />} onClick={() => select({ kind: "import" })} />
    </div>
  ) : selection.kind === "provider" ? (
    <ConnectWizard descriptor={selection.descriptor} onConnected={() => onDone()} />
  ) : (
    <ImportKubeconfigPanel onDone={() => onDone()} />
  );
}
