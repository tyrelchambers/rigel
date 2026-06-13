import { useEffect, useMemo, useState } from "react";
import {
  hasUnfilledMarkers,
  isBaked,
  scanPlaceholders,
  substitute,
  validateManifestShape,
  type CatalogApp,
  type SecretFieldSpec,
} from "@helmsman/catalog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { handoffToChat as sendToChatPane } from "@/lib/chatHandoff";
import { applyManifest, installHelm } from "./installApi";
import {
  canAdvanceFromConfigure,
  fillSecrets,
  initialSecretValues,
  renderArtifact,
  resolveSecretSpecs,
  secretsComplete,
  templateVars,
  type ConfigureValues,
  type WizardStep,
} from "./wizardLogic";
import { ConfigureStep } from "./steps/ConfigureStep";
import { GeneratingStep } from "./steps/GeneratingStep";
import { SecretsStep } from "./steps/SecretsStep";
import { ReviewStep } from "./steps/ReviewStep";
import { ApplyingStep } from "./steps/ApplyingStep";
import { VerifyingStep } from "./steps/VerifyingStep";
import { DoneStep } from "./steps/DoneStep";
import { FailedStep } from "./steps/FailedStep";
import { iconFor } from "./icons";

const STEP_LABEL: Record<WizardStep, string> = {
  configure: "Configure",
  generating: "Generate",
  secrets: "Secrets",
  review: "Review",
  applying: "Apply",
  verifying: "Verify",
  done: "Done",
  failed: "Failed",
};

// Short lowercase breadcrumb labels (mirror the Swift StepIndicator).
const CRUMB_LABEL: Record<WizardStep, string> = {
  configure: "configure",
  generating: "generate",
  secrets: "secrets",
  review: "review",
  applying: "apply",
  verifying: "verify",
  done: "done",
  failed: "failed",
};

// Steps before the install runs — only these are navigable backward.
const PRE_INSTALL: WizardStep[] = ["configure", "generating", "secrets", "review"];

/**
 * Multi-step install wizard state machine
 * (docs/parity/catalog.md §"Install Wizard Flow"):
 *   configure → generating | secrets → review → applying → verifying → done
 *                                            ↘ failed (any step) ↗
 */
export function CatalogInstallWizard({
  app,
  namespaces,
  nodeNames,
  clusterIssuers,
  initialNodePin = null,
  onClose,
}: {
  app: CatalogApp;
  namespaces: string[];
  nodeNames: string[];
  clusterIssuers: string[];
  /** Node the detail sheet pinned the install to; null = "Any". */
  initialNodePin?: string | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<WizardStep>("configure");

  const [config, setConfig] = useState<ConfigureValues>({
    instance: app.id,
    namespace: "default",
    hostname: "",
    nodePin: initialNodePin,
    storageGiB: app.requirements.storageGiB ?? 0,
    clusterIssuer: "",
    notes: "",
  });

  // The substituted artifact (manifest YAML or helm values), filled progressively.
  const [artifact, setArtifact] = useState("");
  const [secretSpecs, setSecretSpecs] = useState<SecretFieldSpec[]>([]);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [applyLog, setApplyLog] = useState("");
  const [failMessage, setFailMessage] = useState("");

  const canAdvance = canAdvanceFromConfigure(app, config);
  const isHelm = app.install?.mode === "helm";
  const appBaked = isBaked(app);

  const Icon = iconFor(app.iconSystemName);

  // The breadcrumb only shows steps this install will actually go through:
  // baked apps skip "generate"; apps with no secret placeholders skip "secrets".
  const needsSecrets = useMemo(() => {
    if (secretSpecs.length > 0) return true;
    const rendered = renderArtifact(app, templateVars(config));
    return rendered != null && scanPlaceholders(rendered).length > 0;
  }, [app, config, secretSpecs.length]);

  const order = useMemo<WizardStep[]>(() => {
    // Not-yet-baked apps hand off to chat at the generate step — the pipeline
    // doesn't continue in the wizard, so the breadcrumb stops there.
    if (!appBaked) return ["configure", "generating"];
    const o: WizardStep[] = ["configure"];
    if (needsSecrets) o.push("secrets");
    o.push("review", "applying", "verifying", "done");
    return o;
  }, [appBaked, needsSecrets]);

  // "failed" collapses onto "apply" so the breadcrumb keeps a sensible current.
  const currentFamily: WizardStep = step === "failed" ? "applying" : step;
  const currentIndex = order.indexOf(currentFamily);

  // Track the farthest step reached so visited steps stay navigable.
  const [farthest, setFarthest] = useState(0);
  useEffect(() => {
    if (currentIndex > farthest) setFarthest(currentIndex);
  }, [currentIndex, farthest]);

  // --- step transitions ----------------------------------------------------

  function handleAdvanceFromConfigure() {
    if (!canAdvance) return;
    const vars = templateVars(config);
    const rendered = renderArtifact(app, vars);
    if (rendered == null) {
      // not-yet-baked → generating (deferred Claude path; hand off to chat)
      setStep("generating");
      return;
    }
    setArtifact(rendered);
    const placeholders = scanPlaceholders(rendered);
    if (placeholders.length > 0) {
      const specs = resolveSecretSpecs(app, rendered);
      setSecretSpecs(specs);
      setSecretValues(initialSecretValues(specs));
      setStep("secrets");
    } else {
      setStep("review");
    }
  }

  const filledArtifact = useMemo(() => {
    if (secretSpecs.length === 0) return artifact;
    return fillSecrets(artifact, secretValues);
  }, [artifact, secretSpecs.length, secretValues]);

  function handleSecretsContinue() {
    if (!secretsComplete(secretSpecs, secretValues)) return;
    setArtifact(filledArtifact);
    setStep("review");
  }

  // Manifest-shape + unfilled-marker guard for the manifest-mode Review step.
  const shapeError = useMemo(() => {
    if (isHelm) return null;
    if (hasUnfilledMarkers(artifact)) {
      return "The manifest still has unfilled <FILL_ME_IN> placeholders.";
    }
    return validateManifestShape(artifact);
  }, [isHelm, artifact]);

  async function handleInstall() {
    setStep("applying");
    setApplyLog("");
    try {
      const result = isHelm
        ? await installHelm({
            repoName: app.install?.repoName ?? "",
            repoURL: app.install?.repoURL ?? "",
            chart: app.install?.chart ?? "",
            version: app.install?.version ?? null,
            releaseName: config.instance,
            namespace: config.namespace,
            values: artifact,
          })
        : await applyManifest(artifact);

      setApplyLog([result.stdout, result.stderr].filter(Boolean).join("\n"));
      if (result.code === 0) {
        setStep("verifying");
      } else {
        setFailMessage(result.stderr || result.stdout || `exit code ${result.code}`);
        setStep("failed");
      }
    } catch (err) {
      setFailMessage(err instanceof Error ? err.message : String(err));
      setStep("failed");
    }
  }

  function handoffToChat(reason: string) {
    const prompt = isHelm
      ? `Continue installing ${app.name} (helm release "${config.instance}" in namespace "${config.namespace}"). ${reason}. Check the release status and pod health, and fix any issues.`
      : `Continue installing ${app.name} (instance "${config.instance}" in namespace "${config.namespace}"). ${reason}. Check the pods labeled app.kubernetes.io/instance=${config.instance} and fix any issues.\n\nManifest:\n\n\`\`\`yaml\n${artifact}\n\`\`\``;
    onClose();
    sendToChatPane(prompt);
  }

  // Hide the breadcrumb only on the terminal failed screen.
  const showStepper = step !== "failed";
  const canGoBack = PRE_INSTALL.includes(currentFamily);

  // --- render --------------------------------------------------------------

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="wizard-dialog max-h-[88vh] w-[min(940px,94vw)] max-w-none sm:max-w-none overflow-auto">
        <DialogHeader className="wizard-header">
          {/* App identity row */}
          <div className="wizard-app-row">
            <div
              className="wizard-app-icon"
              style={{ background: "#26262C", border: "1px solid #2F2F36" }}
              aria-hidden
            >
              <Icon className="wizard-app-icon-glyph" />
            </div>
            <div className="wizard-app-info">
              <DialogTitle className="wizard-title">Install {app.name}</DialogTitle>
              <p className="wizard-step-label">{STEP_LABEL[step]}</p>
            </div>
          </div>

          {/* Step breadcrumb (mirrors the Swift StepIndicator) */}
          {showStepper && (
            <div className="wizard-crumbs" role="list" aria-label="Installation steps">
              {order.map((s, i) => {
                const isCurrent = i === currentIndex;
                const visited = i <= farthest;
                const clickable = canGoBack && visited && i < currentIndex;
                return (
                  <div key={s} className="wizard-crumb-item" role="listitem">
                    <button
                      type="button"
                      className={`wizard-crumb${isCurrent ? " current" : ""}${
                        visited && !isCurrent ? " visited" : ""
                      }`}
                      disabled={!clickable}
                      onClick={() => clickable && setStep(s)}
                      aria-current={isCurrent ? "step" : undefined}
                      title={clickable ? `Go to ${STEP_LABEL[s]}` : STEP_LABEL[s]}
                    >
                      {CRUMB_LABEL[s]}
                    </button>
                    {i < order.length - 1 && <span className="wizard-crumb-sep" aria-hidden>›</span>}
                  </div>
                );
              })}
            </div>
          )}
        </DialogHeader>

        <div className="wizard-body">
          {step === "configure" && (
            <ConfigureStep
              app={app}
              values={config}
              setValues={setConfig}
              namespaces={namespaces}
              nodeNames={nodeNames}
              clusterIssuers={clusterIssuers}
              canAdvance={canAdvance}
              onContinue={handleAdvanceFromConfigure}
            />
          )}

          {step === "generating" && (
            <GeneratingStep
              app={app}
              prompt={substitute(app.installPromptTemplate, templateVars(config))}
              onHandoff={() => handoffToChat("This app isn't baked yet")}
              onBack={() => setStep("configure")}
            />
          )}

          {step === "secrets" && (
            <SecretsStep
              specs={secretSpecs}
              values={secretValues}
              setValues={setSecretValues}
              canContinue={secretsComplete(secretSpecs, secretValues)}
              onContinue={handleSecretsContinue}
              onBack={() => setStep("configure")}
            />
          )}

          {step === "review" && (
            <ReviewStep
              app={app}
              artifact={artifact}
              values={config}
              shapeError={shapeError}
              onInstall={handleInstall}
              onBack={() => setStep(secretSpecs.length > 0 ? "secrets" : "configure")}
            />
          )}

          {step === "applying" && <ApplyingStep log={applyLog} />}

          {step === "verifying" && (
            <VerifyingStep
              instance={config.instance}
              namespace={config.namespace}
              onDone={() => setStep("done")}
              onHandoff={handoffToChat}
            />
          )}

          {step === "done" && <DoneStep app={app} values={config} onClose={onClose} />}

          {step === "failed" && (
            <FailedStep
              message={failMessage}
              onBack={() => setStep("review")}
              onRetry={handleInstall}
              onHandoff={() => handoffToChat("The install failed")}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
