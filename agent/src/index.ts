import { classifyRisk, RiskTier } from "./classifier.js";
import { loadConfig, isEnabled, type Config } from "./config.js";
import {
  detectDegradedDeployments,
  detectUnhealthyPods,
  fingerprint,
  type Incident,
} from "./detector.js";
import { kubectl } from "./kubectl.js";
import { toKubectlInvocations, type SuggestedAction } from "./action.js";
import { runWorker } from "./worker.js";
import { runSupervisor } from "./supervisor.js";
import { executeAction } from "./executor.js";
import { CircuitBreaker, SpendTracker } from "./guardrails.js";
import {
  appendAudit,
  readState,
  storeBackup,
  writeState,
  type AssistantState,
  type AuditEntry,
} from "./state.js";

const VERSION = "0.1.0";

function log(msg: string): void {
  process.stdout.write(`[assistant] ${new Date().toISOString()} ${msg}\n`);
}

function nsArgs(cfg: Config): string[] {
  // Always list cluster-wide, then filter — simpler than per-namespace fan-out.
  return ["-A"];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { items: [] };
  }
}

async function detectAll(cfg: Config): Promise<Incident[]> {
  const [pods, deps] = await Promise.all([
    kubectl(["get", "pods", ...nsArgs(cfg), "-o", "json"]),
    kubectl(["get", "deployments", ...nsArgs(cfg), "-o", "json"]),
  ]);
  let incidents: Incident[] = [];
  if (pods.code === 0) incidents.push(...detectUnhealthyPods(safeParse(pods.stdout)));
  if (deps.code === 0) incidents.push(...detectDegradedDeployments(safeParse(deps.stdout)));
  if (cfg.namespaces.length > 0) {
    const allow = new Set(cfg.namespaces);
    incidents = incidents.filter((i) => i.namespace === "" || allow.has(i.namespace));
  }
  return incidents;
}

interface LoopState {
  streaks: Map<string, number>;
  handled: Set<string>;
}

async function tick(
  cfg: Config,
  cb: CircuitBreaker,
  spend: SpendTracker,
  loop: LoopState,
): Promise<void> {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  let state = await readState(cfg.stateConfigMap, cfg.stateNamespace);

  const enabled = await isEnabled(cfg);
  state = {
    ...state,
    updatedAt: ts,
    status: { heartbeatAt: ts, spentUsd: spend.total(), spendCapUsd: cfg.spendCapUsd, enabled, version: VERSION },
  };

  if (!enabled) {
    log("kill-switch is off — idle");
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    return;
  }
  if (!spend.canSpend()) {
    log(`spend cap reached ($${cfg.spendCapUsd}) — idle (fail-closed)`);
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    return;
  }

  const incidents = await detectAll(cfg);
  const present = new Set(incidents.map(fingerprint));

  // Recovered incidents fall out of the debounce/handled tracking so a fresh
  // recurrence re-triggers.
  for (const fp of [...loop.streaks.keys()]) {
    if (!present.has(fp)) {
      loop.streaks.delete(fp);
      loop.handled.delete(fp);
    }
  }
  for (const i of incidents) {
    const fp = fingerprint(i);
    loop.streaks.set(fp, (loop.streaks.get(fp) ?? 0) + 1);
  }

  const confirmed = incidents.filter((i) => {
    const fp = fingerprint(i);
    return (loop.streaks.get(fp) ?? 0) >= cfg.confirmPolls && !loop.handled.has(fp);
  });

  if (confirmed.length > 0) log(`handling ${confirmed.length} confirmed incident(s)`);

  for (const incident of confirmed) {
    if (!spend.canSpend()) break;
    const fp = fingerprint(incident);
    const resourceKey = `${incident.namespace}/${incident.name}`;
    loop.handled.add(fp);

    let analysis = "";
    let actions;
    try {
      const out = await runWorker(cfg, [incident]);
      spend.add(out.costUsd);
      analysis = out.analysis;
      actions = out.actions;
    } catch (e) {
      // Fail closed: a worker failure never results in an action.
      const msg = String(e);
      if (/auth|oauth|401|token|unauthor/i.test(msg)) {
        // Loud signal in the report — almost certainly the 1-year token lapsed.
        state = { ...state, report: `⚠️ Claude auth is failing — the subscription token may have expired. Re-run \`claude setup-token\` and update the assistant-claude-token Secret. (${msg})` };
      }
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
        outcome: "failure", detail: `worker failed (fail-closed): ${msg}`,
      });
      continue;
    }

    if (!actions || actions.length === 0) {
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
        outcome: "skipped", detail: truncate(analysis),
      });
      continue;
    }

    const action = actions[0]!;
    const tier = classifyRisk(action.kind);
    const tierStr = tier === RiskTier.Medium ? "medium" : "low";

    if (tier === RiskTier.Blocked) {
      state = queue(state, cfg, ts, describe(incident), action.label, "destructive — RBAC-blocked; run manually in Helmsman");
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: "blocked", outcome: "queued", detail: "queued for human (destructive)",
      });
      continue;
    }

    // MEDIUM actions must clear the adversarial Opus supervisor first. LOW
    // actions execute on the deterministic guardrails alone.
    let execVerdict: "auto" | "approved" = "auto";
    if (tier === RiskTier.Medium) {
      if (!spend.canSpend()) {
        state = queue(state, cfg, ts, describe(incident), action.label, "medium-risk — spend cap reached before supervision", action);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
          tier: "medium", verdict: "escalated", outcome: "queued", detail: "queued (spend cap before supervision)",
        });
        continue;
      }
      const command = previewCommand(action);
      let sup;
      try {
        sup = await runSupervisor(cfg, incident, action, analysis, command);
        spend.add(sup.costUsd);
      } catch (e) {
        // Fail closed: supervisor unreachable / malformed verdict → never act.
        state = queue(state, cfg, ts, describe(incident), action.label, "medium-risk — supervisor error (fail-closed)", action);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
          tier: "medium", verdict: "escalated", outcome: "queued", detail: `supervisor failed (fail-closed): ${String(e)}`,
        });
        continue;
      }
      if (sup.verdict.decision === "reject") {
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
          tier: "medium", verdict: "rejected", outcome: "skipped",
          detail: `Opus rejected (conf ${sup.verdict.confidence.toFixed(2)}): ${sup.verdict.reason}`,
        });
        continue;
      }
      if (sup.verdict.decision === "escalate") {
        state = queue(state, cfg, ts, describe(incident), action.label, `medium-risk — Opus escalated: ${sup.verdict.reason}`, action);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
          tier: "medium", verdict: "escalated", outcome: "queued",
          detail: `Opus escalated (conf ${sup.verdict.confidence.toFixed(2)}): ${sup.verdict.reason}`,
        });
        continue;
      }
      execVerdict = "approved";
      log(`Opus approved (conf ${sup.verdict.confidence.toFixed(2)}): ${action.label}`);
    }

    // LOW (auto) or MEDIUM (Opus-approved) — execute under the circuit breaker.
    const cbVerdict = cb.canAct(fp, resourceKey, now);
    if (!cbVerdict.allowed) {
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: tierStr, outcome: "skipped", detail: cbVerdict.reason ?? "blocked by circuit breaker",
      });
      continue;
    }

    cb.record(fp, resourceKey, now);
    try {
      const result = await executeAction(action);
      let backupRef: string | undefined;
      if (result.backupYaml) {
        const key = `${ts}_${fp}`.replace(/[^A-Za-z0-9_.-]/g, "_");
        backupRef = await storeBackup(cfg.backupsConfigMap, cfg.stateNamespace, key, result.backupYaml, cfg.maxBackups);
      }
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        command: result.commands.join(" && "), tier: tierStr, verdict: execVerdict,
        outcome: result.success ? "success" : "failure", detail: truncate(result.output), backupRef,
      });
      log(`${result.success ? "✓" : "✗"} ${action.label} — ${result.commands.join(" && ")}`);
    } catch (e) {
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: tierStr, verdict: execVerdict, outcome: "failure", detail: String(e),
      });
    }
  }

  await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
}

function record(state: AssistantState, cfg: Config, entry: AuditEntry): AssistantState {
  return appendAudit(state, entry, cfg.auditMaxEntries);
}

function queue(
  state: AssistantState,
  cfg: Config,
  at: string,
  incident: string,
  suggestion: string,
  reason: string,
  action?: SuggestedAction,
): AssistantState {
  const exists = state.queue.some((q) => q.incident === incident && q.suggestion === suggestion);
  if (exists) return state;
  return { ...state, queue: [{ at, incident, suggestion, reason, action }, ...state.queue].slice(0, cfg.auditMaxEntries) };
}

function describe(i: Incident): string {
  const loc = i.namespace ? `${i.namespace}/${i.name}` : i.name;
  return `${loc}: ${i.reason}${i.detail ? ` (${i.detail})` : ""}`;
}

function previewCommand(action: SuggestedAction): string {
  return toKubectlInvocations(action)
    .map((args) => "kubectl " + args.join(" "))
    .join(" && ");
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log(`starting v${VERSION} — worker=${cfg.workerModel} poll=${cfg.pollIntervalMs}ms cap=$${cfg.spendCapUsd}`);
  const cb = new CircuitBreaker({
    maxPerResourcePerHour: cfg.maxPerResourcePerHour,
    maxPerNight: cfg.maxPerNight,
    maxAttemptsPerIncident: cfg.maxAttemptsPerIncident,
    windowMs: cfg.windowMs,
  });
  const spend = new SpendTracker(cfg.spendCapUsd);
  const loop: LoopState = { streaks: new Map(), handled: new Set() };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick(cfg, cb, spend, loop);
    } catch (e) {
      log(`tick error: ${String(e)}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((e) => {
  log(`fatal: ${String(e)}`);
  process.exit(1);
});
