import type { KindAccess } from "@/store/cluster";

export function KindAccessNotice({ kind, access }: { kind: string; access?: KindAccess }) {
  if (!access || access.status === "ok") return null;
  return (
    <p className="px-4 py-4 text-sm text-muted-foreground">
      {access.status === "forbidden" ? `No access to ${kind}.` : `Couldn't load ${kind}.`}
    </p>
  );
}
