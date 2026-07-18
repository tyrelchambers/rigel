import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@awesome.me/kit-6050953220/icons/classic/solid";

/** A small overlay dot shown on a cloud tile whose login has expired. */
export function ClusterHealthBadge({ onReconnect }: { onReconnect: () => void }) {
  return (
    <button
      type="button"
      aria-label="Needs re-login"
      title="Login expired — click to re-connect"
      onClick={onReconnect}
      style={{
        position: "absolute", top: -2, right: -2, width: 16, height: 16, borderRadius: 8, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
        background: "var(--destructive)", border: "2px solid var(--surface-primary)", color: "#fff",
      }}
    >
      <FontAwesomeIcon icon={faTriangleExclamation} className="size-[9px]" />
    </button>
  );
}
