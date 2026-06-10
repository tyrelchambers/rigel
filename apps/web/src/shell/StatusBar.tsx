/**
 * StatusBar — thin bottom chrome bar.
 * Mirrors StatusBar.swift: connectivity dot (kubectl ok / error), pod count,
 * and basic cluster context info from GET /api/health.
 */
import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { useCluster } from "@/store/cluster";

interface HealthData {
  context?: string;
  ok?: boolean;
}

export default function StatusBar() {
  const connected = useCluster((s) => s.connected);
  const resources = useCluster((s) => s.resources);
  const error = useCluster((s) => s.error);

  const [health, setHealth] = useState<HealthData>({});

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(d as HealthData))
      .catch(() => {/* ignore — optional data */});
  }, []);

  const podCount = Object.keys(resources["pods"] ?? {}).length;
  const nodeCount = Object.keys(resources["nodes"] ?? {}).length;

  const kubectlOk = connected && !error;
  const statusColor = kubectlOk ? "#10B981" : "#EF4444";
  const statusLabel = kubectlOk ? "kubectl: ok" : "kubectl: error";

  return (
    <div
      style={{
        height: 22,
        background: "#050505",
        borderTop: "1px solid #1A1A1A",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px",
        flexShrink: 0,
      }}
    >
      {/* Context */}
      {health.context && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Network size={9} style={{ color: "#6B6B73" }} />
          <span
            style={{
              fontFamily: "'Geist Variable', ui-monospace, monospace",
              fontSize: 10,
              color: "#A1A1AA",
            }}
          >
            {health.context}
          </span>
        </div>
      )}

      {/* Pod / node chips */}
      {podCount > 0 && <Chip label="pods" value={String(podCount)} />}
      {nodeCount > 0 && <Chip label="nodes" value={String(nodeCount)} />}

      <div style={{ flex: 1 }} />

      {/* kubectl status */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "'Geist Variable', ui-monospace, monospace",
            fontSize: 10,
            color: kubectlOk ? "#6B6B73" : "#EF4444",
          }}
          title={error ?? undefined}
        >
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

interface ChipProps {
  label: string;
  value: string;
}

function Chip({ label, value }: ChipProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontSize: 9,
          color: "#6B6B73",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'Geist Variable', ui-monospace, monospace",
          fontSize: 10,
          fontWeight: 500,
          color: "#A1A1AA",
        }}
      >
        {value}
      </span>
    </div>
  );
}
