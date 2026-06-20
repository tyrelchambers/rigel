// InstallView — shown when the agent is not installed.
// The install namespace is owned by context (shared with useAssistant before
// the agent exists); the rest of the form state is local to this component.

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_INSTALL_CONFIG,
  manifestYAML,
  SECRET_NAME,
  type AssistantInstallConfig,
} from "@rigel/k8s";
import { useChatConfig } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { Card, Field, inputClass } from "../components/primitives";

export function InstallView() {
  const {
    d,
    working,
    run,
    actionError: _actionError,
    setInstallNamespace,
    installNamespace,
    openConfirmCreateNs,
  } = useAssistantCtx();

  // Local install-form state (everything except installNamespace which lives in ctx).
  const [config, setConfig] = useState<AssistantInstallConfig>({
    ...DEFAULT_INSTALL_CONFIG,
    installNamespace,
  });
  const [installToken, setInstallToken] = useState("");
  const [showManifest, setShowManifest] = useState(false);

  // If a token is already saved (onboarding / Settings), the server reuses it —
  // so the user doesn't have to paste it again here.
  const { data: chatConfig } = useChatConfig();
  const hasSavedToken = chatConfig?.configured ?? false;

  // Keep local config.installNamespace in sync with ctx.installNamespace.
  // The user types in the local input → we update both local config and ctx.
  function handleNsChange(ns: string) {
    setConfig((c) => ({ ...c, installNamespace: ns }));
    setInstallNamespace(ns);
  }

  const namespaceMissing = useMemo(() => {
    const ns = config.installNamespace.trim();
    if (ns === "") return false;
    return !d.allNamespaceNames.includes(ns);
  }, [config.installNamespace, d.allNamespaceNames]);

  const monitored = useMemo(
    () =>
      new Set(
        config.namespaces
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    [config.namespaces],
  );

  function toggleMonitored(name: string) {
    const next = new Set(monitored);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setConfig((c) => ({ ...c, namespaces: [...next].sort().join(",") }));
  }

  function doInstall() {
    const token = installToken.trim();
    const image = config.image.trim();
    const namespace = config.installNamespace.trim();
    if (token === "" && !hasSavedToken) return; // need a token, pasted or saved
    if (image === "") return;
    const repoPath = image.split(":")[0] ?? image;
    if (repoPath !== repoPath.toLowerCase()) return;
    if (namespace === "") return;
    if (namespace !== namespace.toLowerCase()) return;
    run(
      {
        action: "install",
        namespace,
        token, // empty when reusing the saved token — the server falls back to it
        image,
        spendCapUsd: config.spendCapUsd,
        monitorNamespaces: config.namespaces,
      },
      () => setInstallToken(""),
    );
  }

  function handleInstall() {
    if (installToken.trim() === "" && !hasSavedToken) return; // button is disabled anyway
    if (config.image.trim() === "" || config.installNamespace.trim() === "") return;
    if (namespaceMissing) openConfirmCreateNs(doInstall);
    else doInstall();
  }

  return (
    <div className="space-y-3">
      <Card>
        <p className="text-sm font-semibold">Install the in-cluster assistant</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A pod that watches the cluster and auto-fixes safe issues while you're away. It is caged
          by RBAC: it can read everything except secrets, and only restart/scale/rollback workloads,
          delete crashlooping pods, and cordon nodes. It can never delete namespaces, PVCs, secrets,
          or change RBAC — those only ever appear here as suggestions for you to run.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">1. Subscription token</p>
        {hasSavedToken ? (
          <p className="mt-1 text-sm text-muted-foreground">
            ✓ Using the token you already saved. Paste a new one below only to replace it.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              On a machine logged into your Claude plan, run:
            </p>
            <p className="select-text font-mono text-sm text-primary">claude setup-token</p>
            <p className="mt-1 text-sm text-muted-foreground">Paste the token below.</p>
          </>
        )}
        <input
          type="password"
          autoComplete="off"
          value={installToken}
          onChange={(e) => setInstallToken(e.target.value)}
          placeholder={hasSavedToken ? "Paste a new token to replace (optional)" : "CLAUDE_CODE_OAUTH_TOKEN"}
          className={`mt-2 w-full ${inputClass}`}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Stored as Secret <code className="select-text font-mono">{SECRET_NAME}</code> in namespace{" "}
          <code className="select-text font-mono">{config.installNamespace.trim() || "default"}</code> — never shown again.
        </p>
      </Card>

      <Card className="space-y-2">
        <p className="text-sm font-semibold">2. Configuration</p>
        <Field label="Image">
          <input
            value={config.image}
            onChange={(e) => setConfig((c) => ({ ...c, image: e.target.value }))}
            className={inputClass}
          />
        </Field>
        <Field label="Install namespace">
          <input
            value={config.installNamespace}
            onChange={(e) => handleNsChange(e.target.value)}
            className={inputClass}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" title="Pick an existing namespace" />}
            >
              <ChevronDown className="size-4 text-primary" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {d.allNamespaceNames.map((name) => (
                <DropdownMenuItem key={name} onClick={() => handleNsChange(name)}>
                  {name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        {namespaceMissing && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Namespace "{config.installNamespace}" doesn't exist — you'll be asked to create it on
            Install.
          </p>
        )}
        <Field label="Monitor namespaces">
          <DropdownMenu>
            <DropdownMenuTrigger className={`flex items-center justify-between ${inputClass}`}>
              <span className="truncate">
                {monitored.size === 0 ? "All namespaces" : [...monitored].sort().join(", ")}
              </span>
              <ChevronDown className="size-4 shrink-0 text-primary" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setConfig((c) => ({ ...c, namespaces: "" }))}>
                {monitored.size === 0 ? "✓ All namespaces" : "All namespaces"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {d.allNamespaceNames.map((name) => (
                <DropdownMenuItem
                  key={name}
                  closeOnClick={false}
                  onClick={() => toggleMonitored(name)}
                >
                  {monitored.has(name) ? `✓ ${name}` : name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        <Field label="Spend cap ($/mo)">
          <input
            type="number"
            min={0}
            value={config.spendCapUsd}
            onChange={(e) =>
              setConfig((c) => ({ ...c, spendCapUsd: Math.max(0, Number(e.target.value) || 0) }))
            }
            className={`w-28 ${inputClass}`}
          />
        </Field>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">3. Review manifests</p>
          <Button variant="ghost" size="sm" onClick={() => setShowManifest(!showManifest)}>
            {showManifest ? "Hide" : "Show"}
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Exactly what will be applied — including the RBAC cage. Nothing is applied until you click
          Install. The token Secret is not shown here.
        </p>
        {showManifest && (
          <pre className="mt-2 max-h-56 select-text overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre">
            {manifestYAML(config)}
          </pre>
        )}
      </Card>

      <Button
        className="w-full"
        disabled={working || (installToken.trim() === "" && !hasSavedToken)}
        onClick={handleInstall}
      >
        {working ? "Installing…" : "Install"}
      </Button>
    </div>
  );
}
