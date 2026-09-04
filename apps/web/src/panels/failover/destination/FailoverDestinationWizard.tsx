import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faCircleNodes,
  faServer,
  faTriangleExclamation,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { FAILOVER_PROVIDER_CHOICES } from "@rigel/k8s/src/failover/providers";
import { suggestAddressing } from "@rigel/k8s/src/failover/objectStoreAddressing";
import {
  BackButton,
  OptionCard,
  PrimaryButton,
  SegmentedToggle,
  WizardBody,
  WizardFooter,
  WizardInput,
  WizardIntro,
  WizardShell,
  CAPTION,
  SUB,
} from "@/panels/settings/WizardParts";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { detectOS, pkgLabel } from "@/shell/installHelp";
import { useQuery } from "@tanstack/react-query";
import { descriptorFor } from "@rigel/cloud-connect/src/index";
import {
  cloudCheck,
  useSaveFailoverConfig,
  validateFailoverDestination,
  type FailoverConfigPatch,
  type FailoverConfigView,
  type FailoverValidationView,
} from "@/lib/api";
import { formatEdgeLines, parseEdgeLines } from "./edgeLines";

const STEPS = ["Destination", "Credentials", "Object store", "Cluster", "Edge", "Review"] as const;
type Step = (typeof STEPS)[number];

interface Draft {
  provider: string;
  token: string;
  storeSkipped: boolean;
  endpoint: string;
  storeRegion: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  addressing: "virtualHost" | "path";
  region: string;
  nodeSize: string;
  nodeCount: string;
  edgeHost: string;
  edgeBackends: string;
}

function draftFrom(view?: FailoverConfigView): Draft {
  return {
    provider: view?.provider ?? "digitalocean",
    token: "",
    storeSkipped: !view?.objectStore,
    endpoint: view?.objectStore?.endpoint ?? "",
    storeRegion: view?.objectStore?.region ?? "",
    bucket: view?.objectStore?.bucket ?? "",
    accessKey: "",
    secretKey: "",
    addressing: view?.objectStore?.addressing ?? "path",
    region: view?.region ?? "",
    nodeSize: view?.nodeSize ?? "",
    nodeCount: String(view?.nodeCount ?? 1),
    edgeHost: view?.edge?.host ?? "",
    edgeBackends: formatEdgeLines(view?.edge?.backends ?? []),
  };
}

/** What the wizard sends. Untouched secrets are omitted so stored ones survive. */
function patchFrom(d: Draft, view?: FailoverConfigView): FailoverConfigPatch {
  const patch: FailoverConfigPatch = {
    region: d.region || undefined,
    nodeSize: d.nodeSize || undefined,
    nodeCount: Number(d.nodeCount) >= 1 ? Number(d.nodeCount) : undefined,
  };
  if (d.token.trim()) patch.token = d.token.trim();
  if (d.storeSkipped) {
    if (view?.objectStore) patch.objectStore = null;
  } else if (d.endpoint.trim()) {
    patch.objectStore = {
      endpoint: d.endpoint.trim(),
      region: d.storeRegion.trim(),
      bucket: d.bucket.trim(),
      addressing: d.addressing,
      ...(d.accessKey.trim() ? { accessKey: d.accessKey.trim() } : {}),
      ...(d.secretKey.trim() ? { secretKey: d.secretKey.trim() } : {}),
    };
  }
  if (d.edgeHost.trim()) patch.edge = { host: d.edgeHost.trim(), backends: parseEdgeLines(d.edgeBackends) };
  return patch;
}

function Callout({ tone, children }: { tone: "amber" | "green" | "red"; children: React.ReactNode }) {
  const color =
    tone === "green" ? "var(--status-running)" : tone === "amber" ? "var(--status-pending)" : "var(--status-failed)";
  return (
    <div
      className="flex items-start gap-2 rounded-lg p-3 text-xs"
      style={{ border: `1px solid ${color}`, background: "var(--surface-sunken)", color, lineHeight: 1.45 }}
    >
      <FontAwesomeIcon
        icon={tone === "green" ? faCheck : faTriangleExclamation}
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span>{children}</span>
    </div>
  );
}

export function FailoverDestinationWizard({
  open,
  onOpenChange,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view?: FailoverConfigView;
}) {
  const initial = draftFrom(view);
  const [draft, setDraft] = useState<Draft>(initial);
  const [step, setStep] = useState<Step>("Destination");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<FailoverValidationView | null>(null);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [storeChecked, setStoreChecked] = useState(false);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const save = useSaveFailoverConfig();
  const cloud = useQuery({
    queryKey: ["cloud-check", "digitalocean"] as const,
    queryFn: () => cloudCheck("digitalocean"),
    enabled: open,
  });
  const installHelp = descriptorFor("digitalocean")?.installHelp;
  const osKey = detectOS() ?? "macos";

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === "token") setTokenChecked(false);
    if (["endpoint", "storeRegion", "bucket", "accessKey", "secretKey", "addressing"].includes(key as string)) {
      setStoreChecked(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const index = STEPS.indexOf(step);
  const go = (to: Step) => {
    setError("");
    setStep(to);
  };

  function requestClose(next: boolean) {
    if (next) return onOpenChange(true);
    if (dirty) return setConfirmClose(true);
    onOpenChange(false);
  }

  async function check(which: "token" | "store") {
    setChecking(true);
    setError("");
    try {
      const out = await validateFailoverDestination(patchFrom(draft, view));
      setResult(out);
      if (which === "token") setTokenChecked(out.api.ok);
      else setStoreChecked(!!out.objectStore?.ok);
      if (!out.api.ok && which === "token") setError(out.api.error);
      if (which === "store" && out.objectStore && !out.objectStore.ok) setError(out.objectStore.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  const regions = result?.options?.regions ?? [];
  const sizes = result?.options?.sizes ?? [];

  return (
    <>
      <WizardShell
        open={open}
        onOpenChange={requestClose}
        title="Failover destination"
        icon={<FontAwesomeIcon icon={faCircleNodes} className="size-[18px]" />}
        iconTone="accent"
        progress={(index + 1) / STEPS.length}
        footer={
          <WizardFooter
            left={index > 0 ? <BackButton onClick={() => go(STEPS[index - 1]!)} /> : undefined}
            right={
              step === "Destination" ? (
                <PrimaryButton label="Continue" onClick={() => go("Credentials")} />
              ) : step === "Credentials" ? (
                tokenChecked ? (
                  <PrimaryButton label="Continue" onClick={() => go("Object store")} />
                ) : (
                  <PrimaryButton
                    label="Validate"
                    busy={checking}
                    busyLabel="Checking…"
                    disabled={!draft.token.trim() && !view?.tokenSet}
                    onClick={() => check("token")}
                  />
                )
              ) : step === "Object store" ? (
                draft.storeSkipped || storeChecked ? (
                  <PrimaryButton label="Continue" onClick={() => go("Cluster")} />
                ) : (
                  <PrimaryButton
                    label="Validate"
                    busy={checking}
                    busyLabel="Checking…"
                    disabled={!draft.endpoint.trim() || !draft.bucket.trim()}
                    onClick={() => check("store")}
                  />
                )
              ) : step === "Cluster" ? (
                <PrimaryButton label="Continue" disabled={!draft.region || !draft.nodeSize} onClick={() => go("Edge")} />
              ) : step === "Edge" ? (
                <PrimaryButton
                  label="Continue"
                  disabled={!!draft.edgeHost.trim() && parseEdgeLines(draft.edgeBackends).length === 0}
                  onClick={() => go("Review")}
                />
              ) : (
                <PrimaryButton
                  label="Save destination"
                  busy={save.isPending}
                  busyLabel="Saving…"
                  onClick={() =>
                    save.mutate(patchFrom(draft, view), {
                      onSuccess: () => onOpenChange(false),
                      onError: (e) => setError(e.message),
                    })
                  }
                />
              )
            }
          />
        }
      >
        <WizardBody>
          {step === "Destination" && (
            <>
              <WizardIntro
                lead="Where should a failover go?"
                sub="Rigel stands a copy of your apps up here when you take home down. Nothing is created until you run a failover."
              />
              {FAILOVER_PROVIDER_CHOICES.map((c) => (
                <OptionCard
                  key={c.id}
                  tone={c.available ? "accent" : "amber"}
                  tag={c.available ? "AVAILABLE" : "COMING SOON"}
                  title={c.displayName}
                  desc={c.blurb}
                  icon={<FontAwesomeIcon icon={faServer} className="size-[18px]" />}
                  selected={c.available && draft.provider === c.id}
                  disabled={!c.available}
                  onClick={() => set("provider", c.id)}
                />
              ))}
            </>
          )}

          {step === "Credentials" && (
            <>
              <WizardIntro
                lead="Connect to DigitalOcean"
                sub="Checked against the DigitalOcean API before anything is saved, so a bad token turns up now and not during the storm you set this up for."
              />
              <WizardInput
                label={view?.tokenSet ? "API token (stored)" : "API token"}
                type="password"
                value={draft.token}
                onChange={(v) => set("token", v)}
                placeholder={view?.tokenSet ? "Leave blank to keep the stored token" : "dop_v1_..."}
                hint="Needs read, create and delete access to Kubernetes."
              />
              {tokenChecked && result?.api.ok && (
                <Callout tone="green">Signed in as {result.api.email || "your account"}.</Callout>
              )}
              {error && <Callout tone="red">{error}</Callout>}
            </>
          )}

          {step === "Object store" && (
            <>
              <WizardIntro
                lead="An off-site copy of the dumps"
                sub="Optional. During a failover the database dumps and volumes are uploaded here as well as into the new cluster. Any S3-compatible store works."
              />
              {draft.storeSkipped ? (
                <>
                  <Callout tone="amber">
                    Without an object store the new cluster holds the only copy of your data. If home does not come
                    back, that is all there is.
                  </Callout>
                  <Button size="sm" variant="outline" onClick={() => set("storeSkipped", false)}>
                    Add an object store
                  </Button>
                </>
              ) : (
                <>
                  <WizardInput
                    label="Endpoint"
                    value={draft.endpoint}
                    onChange={(v) => {
                      set("endpoint", v);
                      setDraft((d) => ({ ...d, endpoint: v, addressing: suggestAddressing(v) }));
                    }}
                    placeholder="https://tor1.digitaloceanspaces.com"
                  />
                  <WizardInput
                    label="Signing region"
                    value={draft.storeRegion}
                    onChange={(v) => set("storeRegion", v)}
                    placeholder="us-east-1"
                  />
                  <WizardInput
                    label="Bucket"
                    value={draft.bucket}
                    onChange={(v) => set("bucket", v)}
                    placeholder="rigel-failover"
                  />
                  <div className="flex flex-col gap-2">
                    <span className="text-xs" style={{ color: SUB }}>Addressing</span>
                    <SegmentedToggle
                      value={draft.addressing}
                      onChange={(v) => set("addressing", v)}
                      options={[
                        { id: "virtualHost" as const, label: "bucket.host", icon: null },
                        { id: "path" as const, label: "host/bucket", icon: null },
                      ]}
                    />
                    <span className="text-2xs" style={{ color: CAPTION }}>
                      AWS S3 and Spaces answer on bucket.host. Garage and MinIO usually answer on host/bucket unless
                      you set up wildcard DNS for them.
                    </span>
                  </div>
                  <WizardInput
                    label={view?.objectStore?.accessKeySet ? "Access key (stored)" : "Access key"}
                    type="password"
                    value={draft.accessKey}
                    onChange={(v) => set("accessKey", v)}
                    placeholder={view?.objectStore?.accessKeySet ? "Leave blank to keep" : ""}
                  />
                  <WizardInput
                    label={view?.objectStore?.secretKeySet ? "Secret key (stored)" : "Secret key"}
                    type="password"
                    value={draft.secretKey}
                    onChange={(v) => set("secretKey", v)}
                    placeholder={view?.objectStore?.secretKeySet ? "Leave blank to keep" : ""}
                  />
                  {result?.objectStore?.ok && (
                    <>
                      <Callout tone="green">
                        {result.objectStore.bucketExists
                          ? "Bucket found."
                          : "Bucket will be created when you save."}
                      </Callout>
                      {result.objectStore.insideSourceCluster && (
                        <Callout tone="amber">
                          This endpoint looks like it is inside the cluster you would be failing away from. A copy
                          stored there goes down with the building. You can continue, but it is not an off-site copy.
                        </Callout>
                      )}
                    </>
                  )}
                  {error && <Callout tone="red">{error}</Callout>}
                  <Button size="sm" variant="ghost" onClick={() => set("storeSkipped", true)}>
                    Skip this step
                  </Button>
                </>
              )}
            </>
          )}

          {step === "Cluster" && (
            <>
              <WizardIntro
                lead="How big should the copy be?"
                sub="Created the moment you run a failover, and destroyed when you restore home. It is not running now."
              />
              <Choice
                label="Region"
                value={draft.region}
                onChange={(v) => set("region", v)}
                options={regions}
                empty="Validate your token first to load the regions this account can use."
              />
              <Choice
                label="Node size"
                value={draft.nodeSize}
                onChange={(v) => set("nodeSize", v)}
                options={sizes}
                empty="Validate your token first to load the sizes this account can use."
              />
              <WizardInput
                label="Node count"
                value={draft.nodeCount}
                onChange={(v) => set("nodeCount", v)}
                placeholder="1"
              />
              {draft.region && draft.nodeSize && (
                <span className="text-xs" style={{ color: CAPTION, lineHeight: 1.45 }}>
                  {draft.nodeCount} × {draft.nodeSize} in {draft.region}. Billed by DigitalOcean only while a failover
                  cluster exists.
                </span>
              )}
            </>
          )}

          {step === "Edge" && (
            <>
              <WizardIntro
                lead="What sits in front of your cluster?"
                sub="Failing over moves the apps. Something still has to send traffic to the copy. Rigel writes that change for you to paste and never connects to your edge itself."
              />
              <WizardInput
                label="Edge host"
                value={draft.edgeHost}
                onChange={(v) => set("edgeHost", v)}
                placeholder="203.0.113.9"
                hint="The proxy or load balancer your domains already point at."
              />
              <div className="flex flex-col gap-2">
                <span className="text-xs" style={{ color: SUB }}>Backend servers</span>
                <textarea
                  aria-label="Backend servers"
                  value={draft.edgeBackends}
                  onChange={(e) => set("edgeBackends", e.target.value)}
                  placeholder={"node1 10.0.0.1\nnode2 10.0.0.2"}
                  className="h-24 rounded-lg bg-[var(--surface-sunken)] p-3 font-mono text-xs text-foreground outline-none"
                  style={{ border: "1px solid rgba(255,255,255,0.08)" }}
                />
                <span className="text-2xs" style={{ color: CAPTION }}>
                  One name and address per line, matching the server lines in your config. These are what a failover
                  rewrites and a restore puts back.
                </span>
              </div>
              <Callout tone="amber">
                You can leave this empty. A failover will then hand you the load balancer address and let you point
                your edge at it yourself.
              </Callout>
            </>
          )}

          {step === "Review" && (
            <>
              <WizardIntro
                lead="Save this destination"
                sub="Saving creates nothing. It writes the destination into this cluster so a failover has somewhere to go when you need one."
              />
              <Summary
                rows={[
                  ["Provider", "DigitalOcean"],
                  ["Account", result?.api.ok ? result.api.email : "verified"],
                  ["Cluster", `${draft.nodeCount} × ${draft.nodeSize} in ${draft.region}`],
                  [
                    "Object store",
                    draft.storeSkipped
                      ? "Not set"
                      : `${draft.bucket}${result?.objectStore?.ok && !result.objectStore.bucketExists ? " (will be created)" : ""}`,
                  ],
                  [
                    "Edge",
                    draft.edgeHost
                      ? `${draft.edgeHost} · ${parseEdgeLines(draft.edgeBackends).length} servers`
                      : "Not set",
                  ],
                ]}
              />
              {cloud.data && !cloud.data.cliInstalled && (
                <Callout tone="amber">
                  doctl is not installed, and provisioning shells out to it. Needed when you run a failover, not now.
                  {installHelp?.[osKey] && (
                    <>
                      {" "}
                      Install it with {pkgLabel(installHelp[osKey])}: <code>{installHelp[osKey]}</code>
                    </>
                  )}
                </Callout>
              )}
              {error && <Callout tone="red">{error}</Callout>}
            </>
          )}
        </WizardBody>
      </WizardShell>

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent className="w-[420px] p-5">
          <DialogTitle className="text-sm font-semibold">Discard destination setup?</DialogTitle>
          <p className="text-xs text-muted-foreground">Nothing has been saved.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmClose(false);
                onOpenChange(false);
              }}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Choice({
  label,
  value,
  onChange,
  options,
  empty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ slug: string; name: string }>;
  empty: string;
}) {
  if (options.length === 0) {
    return (
      <WizardInput label={label} value={value} onChange={onChange} placeholder="" hint={empty} />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs" style={{ color: SUB }}>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg bg-[var(--surface-sunken)] p-3 text-xs text-foreground outline-none"
        style={{ border: "1px solid rgba(255,255,255,0.08)" }}
      >
        <option value="">Choose one</option>
        {options.map((o) => (
          <option key={o.slug} value={o.slug}>{o.name}</option>
        ))}
      </select>
    </div>
  );
}

function Summary({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="flex flex-col rounded-lg" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
      {rows.map(([k, v], i) => (
        <div
          key={k}
          className="flex items-center justify-between gap-3 px-3.5 py-2.5"
          style={{ borderBottom: i === rows.length - 1 ? undefined : "1px solid rgba(255,255,255,0.06)" }}
        >
          <span className="text-xs" style={{ color: SUB }}>{k}</span>
          <span className="font-mono text-2xs text-foreground">{v}</span>
        </div>
      ))}
    </div>
  );
}
