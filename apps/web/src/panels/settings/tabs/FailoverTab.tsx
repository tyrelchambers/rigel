import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import { ClusterConfigNote, clusterLocked } from "../ClusterConfigNote";
import {
  useFailoverConfig,
  useSaveFailoverConfig,
  type FailoverConfigPatch,
} from "@/lib/api";

const INPUT_CLASS =
  "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary disabled:cursor-not-allowed disabled:opacity-60";

export function FailoverTab() {
  const query = useFailoverConfig();
  const save = useSaveFailoverConfig();
  const view = query.data;
  const locked = clusterLocked(view?.cluster);

  const [region, setRegion] = useState("tor1");
  const [nodeSize, setNodeSize] = useState("s-4vcpu-8gb");
  const [nodeCount, setNodeCount] = useState("2");
  const [token, setToken] = useState("");
  const [spacesKey, setSpacesKey] = useState("");
  const [spacesSecret, setSpacesSecret] = useState("");
  const [edgeHost, setEdgeHost] = useState("");
  const [edgeBackends, setEdgeBackends] = useState("");

  useEffect(() => {
    if (!view) return;
    setRegion(view.region);
    setNodeSize(view.nodeSize);
    setNodeCount(String(view.nodeCount));
    setEdgeHost(view.edge?.host ?? "");
    setEdgeBackends((view.edge?.backends ?? []).map((b) => `${b.name} ${b.ip}`).join("\n"));
    setToken("");
    setSpacesKey("");
    setSpacesSecret("");
  }, [view]);

  function submit() {
    const count = Number(nodeCount);
    const patch: FailoverConfigPatch = {
      region: region.trim(),
      nodeSize: nodeSize.trim(),
      nodeCount: Number.isInteger(count) && count >= 1 ? count : undefined,
    };
    if (token.trim()) patch.token = token.trim();
    if (spacesKey.trim()) patch.spacesKey = spacesKey.trim();
    if (spacesSecret.trim()) patch.spacesSecret = spacesSecret.trim();
    const backends = edgeBackends
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .flatMap(([name, ip]) => (name && ip ? [{ name, ip }] : []));
    if (edgeHost.trim()) patch.edge = { host: edgeHost.trim(), backends };
    save.mutate(patch);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Failover destination</h2>
        {view?.configured && (
          <span className="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-2xs text-[var(--fg-tertiary)]">
            <span className="size-1.5 rounded-full bg-[var(--status-running)]" />
            DigitalOcean saved
          </span>
        )}
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Configured ahead of time so a storm-time failover is a click. Nothing is created in
        DigitalOcean until you run one. v1 is DigitalOcean only, region default tor1.
      </p>
      {view?.cluster && <ClusterConfigNote cluster={view.cluster} />}

      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Region</span>
          <input
            className={INPUT_CLASS}
            value={region}
            disabled={locked}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="tor1"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Node size</span>
          <input
            className={INPUT_CLASS}
            value={nodeSize}
            disabled={locked}
            onChange={(e) => setNodeSize(e.target.value)}
            placeholder="s-4vcpu-8gb"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Node count</span>
          <input
            className={INPUT_CLASS}
            value={nodeCount}
            disabled={locked}
            onChange={(e) => setNodeCount(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="flex flex-col justify-end">
          <p className="text-2xs leading-snug text-[var(--fg-tertiary)]">
            {nodeCount} × {nodeSize} in {region}. Billed by DigitalOcean only while a failover
            cluster exists.
          </p>
        </div>
        <label className="flex flex-col gap-1.5 col-span-2">
          <span className="text-xs text-muted-foreground">Edge host</span>
          <input
            className={INPUT_CLASS}
            value={edgeHost}
            disabled={locked}
            onChange={(e) => setEdgeHost(e.target.value)}
            placeholder="the proxy in front of your cluster, e.g. 203.0.113.9"
          />
          <span className="text-2xs leading-snug text-[var(--fg-tertiary)]">
            Rigel never SSHes here. It only writes the change for you to paste. Leave it empty and a
            failover just gives you the load balancer address instead.
          </span>
        </label>
        <label className="flex flex-col gap-1.5 col-span-2">
          <span className="text-xs text-muted-foreground">Edge backend servers</span>
          <textarea
            className={`${INPUT_CLASS} h-20 font-mono`}
            value={edgeBackends}
            disabled={locked}
            onChange={(e) => setEdgeBackends(e.target.value)}
            placeholder={"node1 10.0.0.1\nnode2 10.0.0.2"}
          />
          <span className="text-2xs leading-snug text-[var(--fg-tertiary)]">
            One "name address" per line, matching the server lines in your proxy config. These are
            what a failover rewrites, and what a restore puts back.
          </span>
        </label>
        <label className="flex flex-col gap-1.5 col-span-2">
          <span className="text-xs text-muted-foreground">
            DigitalOcean API token{view?.tokenSet ? " (set)" : ""}
          </span>
          <input
            className={INPUT_CLASS}
            type="password"
            autoComplete="off"
            value={token}
            disabled={locked}
            onChange={(e) => setToken(e.target.value)}
            placeholder={view?.tokenSet ? "Leave blank to keep the stored token" : "dop_v1_..."}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            Spaces access key{view?.spacesKeySet ? " (set)" : ""}
          </span>
          <input
            className={INPUT_CLASS}
            type="password"
            autoComplete="off"
            value={spacesKey}
            disabled={locked}
            onChange={(e) => setSpacesKey(e.target.value)}
            placeholder={view?.spacesKeySet ? "Leave blank to keep" : ""}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            Spaces secret{view?.spacesSecretSet ? " (set)" : ""}
          </span>
          <input
            className={INPUT_CLASS}
            type="password"
            autoComplete="off"
            value={spacesSecret}
            disabled={locked}
            onChange={(e) => setSpacesSecret(e.target.value)}
            placeholder={view?.spacesSecretSet ? "Leave blank to keep" : ""}
          />
        </label>
      </div>

      {save.error && (
        <p className="text-xs text-[var(--status-failed)]">{save.error.message}</p>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={locked || save.isPending} onClick={submit}>
          Save destination
        </Button>
        {save.isSuccess && (
          <span className="flex items-center gap-1 text-xs text-[var(--status-running)]">
            <FontAwesomeIcon icon={faCheck} className="size-3" />
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
