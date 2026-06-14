import type { CatalogApp } from "@helmsman/catalog";
import { Button } from "@/components/ui/button";
import { namespaceOptions, type ConfigureValues } from "../wizardLogic";

/**
 * Step 1 — Configure. Controlled form for instance / namespace / hostname /
 * storage / node pin / cluster issuer / notes. Conditional fields per app flags.
 */
export function ConfigureStep({
  app,
  values,
  setValues,
  namespaces,
  nodeNames,
  clusterIssuers,
  canAdvance,
  onContinue,
}: {
  app: CatalogApp;
  values: ConfigureValues;
  setValues: (v: ConfigureValues) => void;
  namespaces: string[];
  nodeNames: string[];
  clusterIssuers: string[];
  canAdvance: boolean;
  onContinue: () => void;
}) {
  const update = (patch: Partial<ConfigureValues>) => setValues({ ...values, ...patch });
  const fieldClass =
    "w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canAdvance) onContinue();
      }}
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Instance name</label>
        <input
          className={fieldClass}
          value={values.instance}
          onChange={(e) => update({ instance: e.target.value })}
          placeholder={app.id}
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Namespace</label>
        <select
          className={fieldClass}
          value={values.namespace}
          onChange={(e) => update({ namespace: e.target.value })}
        >
          {namespaceOptions(namespaces, values.namespace).map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </div>

      {app.exposesIngress && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Ingress hostname</label>
          <input
            className={fieldClass}
            value={values.hostname}
            onChange={(e) => update({ hostname: e.target.value })}
            placeholder={`${app.id}.example.com`}
          />
        </div>
      )}

      {app.persistence && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Storage (GiB)</label>
          <input
            type="number"
            min={1}
            className={fieldClass}
            value={values.storageGiB}
            onChange={(e) => update({ storageGiB: Number(e.target.value) })}
          />
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Node pin (optional)</label>
        <select
          className={fieldClass}
          value={values.nodePin ?? ""}
          onChange={(e) => update({ nodePin: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">Any node</option>
          {nodeNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      {app.exposesIngress && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">ClusterIssuer</label>
          <input
            className={fieldClass}
            list="catalog-cluster-issuers"
            value={values.clusterIssuer}
            onChange={(e) => update({ clusterIssuer: e.target.value })}
            placeholder="letsencrypt-prod"
          />
          <datalist id="catalog-cluster-issuers">
            {clusterIssuers.map((ci) => (
              <option key={ci} value={ci} />
            ))}
          </datalist>
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
        <textarea
          className={`${fieldClass} min-h-16`}
          value={values.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={!canAdvance}>
          Continue
        </Button>
      </div>
    </form>
  );
}
