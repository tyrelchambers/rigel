import { classifyRisk, RiskTier } from "./classifier.js";
import { evaluateAlertRules, emptyAlertState } from "./alerts.js";
import { loadConfig, type Config } from "./config.js";
import { readRuntimeConfig, decideAutonomy, type RuntimeConfig } from "./runtimeConfig.js";
import { notifyWebhook, notifySignal, receiveSignal } from "./notify.js";
import { runDiagnosis } from "./diagnose.js";
import { SessionStore } from "./sessionStore.js";
import {
  handleInbound,
  HELP_TEXT,
  SeenTimestamps,
  type InboundHandlers,
} from "./signalInbound.js";
import {
  detectDegradedDeployments,
  detectUnhealthyPods,
  fingerprint,
  type Incident,
} from "./detector.js";
import { kubectl } from "./kubectl.js";
import { toKubectlInvocations, type SuggestedAction } from "./action.js";
import { runThreadedDiagnosis } from "./threadedDiagnosis.js";
import { runWorker } from "./worker.js";
import { diagnoseConfirmed } from "./diagnosePool.js";
import { runSupervisor } from "./supervisor.js";
import { executeAction } from "./executor.js";
import { CircuitBreaker } from "./guardrails.js";
import { runSelfCheck, formatSelfCheck } from "./selfCheck.js";
import {
  appendAudit,
  readState,
  reconcileQueue,
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

function itemsOf(raw: unknown): Record<string, unknown>[] {
  const list = raw as { items?: unknown[] };
  return Array.isArray(list?.items) ? (list.items as Record<string, unknown>[]) : [];
}

async function detectAll(cfg: Config): Promise<{ incidents: Incident[]; pods: Record<string, unknown>[]; deps: Record<string, unknown>[]; podsOk: boolean; depsOk: boolean }> {
  const [podsRes, depsRes] = await Promise.all([
    kubectl(["get", "pods", ...nsArgs(cfg), "-o", "json"]),
    kubectl(["get", "deployments", ...nsArgs(cfg), "-o", "json"]),
  ]);
  const parsedPods = podsRes.code === 0 ? safeParse(podsRes.stdout) : { items: [] };
  const parsedDeps = depsRes.code === 0 ? safeParse(depsRes.stdout) : { items: [] };
  const pods = itemsOf(parsedPods);
  const deps = itemsOf(parsedDeps);
  let incidents: Incident[] = [];
  if (podsRes.code === 0) incidents.push(...detectUnhealthyPods(parsedPods));
  if (depsRes.code === 0) incidents.push(...detectDegradedDeployments(parsedDeps));
  log(
    `detect: pods exit=${podsRes.code} (${podsRes.stdout.length}b) deps exit=${depsRes.code} (${depsRes.stdout.length}b) → ${incidents.length} incident(s) before filter` +
      (incidents.length ? `: ${incidents.map((i) => `${i.namespace}/${i.name}:${i.reason}`).join(", ")}` : "") +
      (podsRes.code !== 0 ? ` | pods stderr: ${podsRes.stderr.slice(0, 200)}` : ""),
  );
  // (namespace filtering moved to tick() so it uses the LIVE rc.limits.namespaces)
  return { incidents, pods, deps, podsOk: podsRes.code === 0, depsOk: depsRes.code === 0 };
}

interface LoopState {
  streaks: Map<string, number>;
  handled: Set<string>;
  /** Inbound Signal messages already processed, so none is answered twice. */
  seen: SeenTimestamps;
  /** Per-sender claude diagnosis threads (1-hour idle reset, in-memory). */
  sessions: SessionStore;
}

async function tick(
  cfg: Config,
  cb: CircuitBreaker,
  loop: LoopState,
): Promise<void> {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  let state = await readState(cfg.stateConfigMap, cfg.stateNamespace);

  const rc = await readRuntimeConfig(cfg);
  // Live operational limits: push the breaker caps from the ConfigMap (defaults
  // to the deploy-time Config when unset — see parseLimits), so a setLimits edit
  // goes live next tick without a restart.
  cb.updateLimits(rc.limits);
  const notifications: string[] = [];
  state = {
    ...state,
    updatedAt: ts,
    status: { heartbeatAt: ts, enabled: rc.enabled, version: VERSION },
  };

  if (!rc.enabled) {
    log("kill-switch is off — idle");
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    return;
  }

  // Drop incidents the operator has silenced (known noise) — no detection,
  // no action on those fingerprints.
  const detection = await detectAll(cfg);
  // Live namespace scope from rc.limits (was deploy-time cfg.namespaces in detectAll).
  const nsAllow = rc.limits.namespaces;
  const scoped = nsAllow.length > 0
    ? detection.incidents.filter((i) => i.namespace === "" || nsAllow.includes(i.namespace))
    : detection.incidents;
  const incidents = scoped.filter((i) => !rc.silenced.has(fingerprint(i)));

  // Re-validate the approval queue against live detection: auto-clear queued
  // suggestions whose incident has cleared (or whose resource is gone), so the
  // queue stays trustworthy.
  {
    const presentNow = new Set(incidents.map(fingerprint));
    const checkedKinds = new Set<string>();
    if (detection.podsOk) checkedKinds.add("unhealthyPod");
    if (detection.depsOk) checkedKinds.add("degradedDeployment");
    const recon = reconcileQueue(state.queue, presentNow, checkedKinds, now, cfg.queueTtlMs);
    if (recon.cleared.length > 0) {
      state = { ...state, queue: recon.kept };
      for (const c of recon.cleared) {
        state = appendAudit(
          state,
          {
            at: ts, fingerprint: c.item.fingerprint ?? "", incident: c.item.incident,
            proposal: c.item.suggestion, tier: "low", outcome: "skipped", detail: c.reason,
          },
          cfg.auditMaxEntries,
        );
      }
      log(`reconcile: auto-cleared ${recon.cleared.length} moot queued item(s)`);
    }
  }

  // Custom alert rules — deterministic, model-less, free-riding the fetch above.
  const alertResult = evaluateAlertRules(
    rc.alertRules,
    detection.pods,
    detection.deps,
    state.alertState ?? emptyAlertState(),
    now,
  );
  state = { ...state, alertState: alertResult.alertState };
  for (const ev of alertResult.events) notifications.push(ev.message);

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
    return (loop.streaks.get(fp) ?? 0) >= rc.limits.confirmPolls && !loop.handled.has(fp);
  });

  if (incidents.length > 0) {
    log(`tick: ${incidents.length} present, confirmPolls=${rc.limits.confirmPolls}, streaks=[${[...loop.streaks.entries()].map(([k, v]) => `${k}=${v}`).join("; ")}], ${confirmed.length} confirmed, ${loop.handled.size} handled`);
  }
  if (confirmed.length > 0) log(`handling ${confirmed.length} confirmed incident(s)`);

  // Stage A: investigate every confirmed incident concurrently (bounded). The
  // Worker model call is the slow, side-effect-free part, so overlapping the
  // calls cuts wall-clock when several incidents land in one tick. The
  // deterministic guardrails stay in Stage B below.
  const packets = await diagnoseConfirmed(
    {
      diagnose: (incident) => runWorker(rc, [incident]),
      limit: cfg.maxConcurrentDiagnoses,
    },
    confirmed,
  );

  // Stage B: decide + execute one incident at a time, in confirmed order, so the
  // circuit breaker and audit log stay deterministic regardless of which
  // diagnosis finished first.
  for (const packet of packets) {
    const incident = packet.incident;
    const fp = fingerprint(incident);
    const resourceKey = `${incident.namespace}/${incident.name}`;

    // Diagnosed — mark handled so we don't re-dispatch next tick.
    loop.handled.add(fp);

    if (packet.error) {
      // Fail closed: a worker failure never results in an action.
      const msg = packet.error;
      if (/auth|oauth|401|token|unauthor/i.test(msg)) {
        // Loud signal in the report — the worker provider's credential is failing (an
        // expired Claude token, a bad API key, etc.). Provider-agnostic: the Assistant
        // tab shows which provider each role uses and where to update its credential.
        state = { ...state, report: `⚠️ The worker AI's credentials are failing (auth error). Update the worker provider's key/token in the Assistant tab. (${msg})` };
      }
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
        outcome: "failure", detail: `worker failed (fail-closed): ${msg}`,
      });
      continue;
    }

    const analysis = packet.analysis;
    const actions = packet.actions;
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
      state = queue(state, cfg, ts, fp, describe(incident), action.label, "destructive — RBAC-blocked; run manually in Rigel");
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: "blocked", outcome: "queued", detail: "queued for human (destructive)", analysis: truncate(analysis),
      });
      notifications.push(`▸ Needs approval (destructive): ${action.label} — ${describe(incident)}`);
      continue;
    }

    // MEDIUM actions must clear the adversarial Opus supervisor first. LOW
    // actions execute on the deterministic guardrails alone.
    let execVerdict: "auto" | "approved" = "auto";
    if (tier === RiskTier.Medium) {
      const command = previewCommand(action);
      let sup;
      try {
        sup = await runSupervisor(rc, incident, action, analysis, command);
      } catch (e) {
        // Fail closed: supervisor unreachable / malformed verdict → never act.
        state = queue(state, cfg, ts, fp, describe(incident), action.label, "medium-risk — supervisor error (fail-closed)", action);
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
        state = queue(state, cfg, ts, fp, describe(incident), action.label, `medium-risk — Opus escalated: ${sup.verdict.reason}`, action);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
          tier: "medium", verdict: "escalated", outcome: "queued",
          detail: `Opus escalated (conf ${sup.verdict.confidence.toFixed(2)}): ${sup.verdict.reason}`, analysis: truncate(analysis),
        });
        notifications.push(`▸ Needs approval (Opus escalated): ${action.label} — ${describe(incident)}`);
        continue;
      }
      execVerdict = "approved";
      log(`Opus approved (conf ${sup.verdict.confidence.toFixed(2)}): ${action.label}`);
    }

    // Autonomy gate: advisory mode (or being outside the quiet-hours window)
    // queues the action for approval instead of auto-executing — even LOW and
    // Opus-approved MEDIUM.
    if (decideAutonomy(rc.mode, rc.window, minOfDay(now)) === "queue") {
      const why = rc.mode === "advisory" ? "advisory mode — suggestion only" : "outside quiet-hours window — queued for approval";
      state = queue(state, cfg, ts, fp, describe(incident), action.label, why, action);
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        command: previewCommand(action), tier: tierStr, outcome: "queued", detail: why, analysis: truncate(analysis),
      });
      notifications.push(`▸ Needs approval: ${action.label} — ${describe(incident)} (${why})`);
      continue;
    }

    // LOW (auto) or MEDIUM (Opus-approved) — execute under the circuit breaker.
    const cbVerdict = cb.canAct(fp, resourceKey, now);
    if (!cbVerdict.allowed) {
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: tierStr, outcome: "skipped", detail: cbVerdict.reason ?? "blocked by circuit breaker", analysis: truncate(analysis),
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
        outcome: result.success ? "success" : "failure", detail: truncate(result.output), backupRef, analysis: truncate(analysis),
      });
      log(`${result.success ? "✓" : "✗"} ${action.label} — ${result.commands.join(" && ")}`);
      notifications.push(`${result.success ? "✓" : "✗"} ${action.label} — ${describe(incident)}`);
    } catch (e) {
      state = record(state, cfg, {
        at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
        tier: tierStr, verdict: execVerdict, outcome: "failure", detail: String(e), analysis: truncate(analysis),
      });
    }
  }

  await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);

  // Best-effort outbound notification for what happened this tick.
  flushNotifications(rc, notifications);

  // Two-way Signal: answer any inbound diagnosis questions / approval commands.
  // Gated on the kill-switch (we already returned above when disabled) and the
  // explicit signalInbound opt-in. Never throws — failures stay out of the loop.
  if (rc.signalInbound && rc.signalApiUrl && rc.signalNumber) {
    try {
      await handleSignalInbound(cfg, rc, cb, loop);
    } catch (e) {
      log(`signal inbound error: ${String(e)}`);
    }
  }
}

/** Wire the real IO handlers and run one inbound poll. `approve` runs a
 * previously-queued, supervised fix through the same circuit breaker + backup
 * path as the autonomous loop. */
async function handleSignalInbound(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): Promise<void> {
  // Allowlist: explicit recipients, else fall back to the linked number itself.
  const allow = rc.signalRecipients.length > 0 ? rc.signalRecipients : rc.signalNumber ? [rc.signalNumber] : [];
  if (allow.length === 0) {
    log("signal inbound: no authorized numbers configured — skipping");
    return;
  }

  const handlers: InboundHandlers = {
    receive: (apiUrl, number) => receiveSignal(apiUrl, number),
    reply: (to, text) => notifySignal(rc.signalApiUrl!, rc.signalNumber!, [to], text),
    help: () => HELP_TEXT,
    status: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      const enabled = s.status?.enabled ? "active" : "disabled";
      return `Rigel assistant is ${enabled}. ${s.queue.length} fix(es) queued. Updated ${s.updatedAt || "—"}.`;
    },
    queue: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      if (s.queue.length === 0) return "No fixes are queued.";
      const lines = s.queue
        .slice(0, 10)
        .map((q, i) => `${i + 1}. ${q.suggestion} — ${q.incident}${q.action ? "" : " (manual; run in Rigel)"}`);
      return `${lines.join("\n")}\n\nReply "approve N" to run one.`;
    },
    approve: (index) => approveQueued(cfg, cb, index),
    diagnose: (question, source, timestamp) =>
      runThreadedDiagnosis(
        {
          sessions: loop.sessions,
          diagnose: (q, resumeId) => runDiagnosis(rc, q, resumeId),
          log,
        },
        source,
        timestamp,
        question,
      ),
    log,
  };

  await handleInbound({ enabled: true, apiUrl: rc.signalApiUrl, number: rc.signalNumber, allow }, handlers, loop.seen);
}

/** Execute a queued suggestion the operator approved over Signal. The human is
 * the approver here, so a MEDIUM-tier fix runs without the unattended Opus
 * supervisor — but every other guardrail still applies: BLOCKED/destructive
 * items are refused, the circuit breaker can veto, and we snapshot a backup
 * before mutating. Mirrors the executor path in `tick`. */
async function approveQueued(cfg: Config, cb: CircuitBreaker, index: number): Promise<string> {
  let state = await readState(cfg.stateConfigMap, cfg.stateNamespace);
  const item = state.queue[index];
  if (!item) return `There's no queued fix #${index + 1}. Reply "queue" to see the list.`;
  if (!item.action) {
    return `"${item.suggestion}" can't be run automatically (destructive / RBAC-blocked). Run it from Rigel.`;
  }
  const action = item.action;
  const tier = classifyRisk(action.kind);
  if (tier === RiskTier.Blocked) {
    return `"${item.suggestion}" is blocked from automatic execution. Run it from Rigel.`;
  }

  const now = Date.now();
  const ts = new Date(now).toISOString();
  const ns = action.namespace ?? "default";
  const targetName = action.deployment ?? action.pod ?? action.node ?? action.label;
  const resourceKey = `${ns}/${targetName}`;
  const fp = item.incident; // best available fingerprint for this queued item

  const cbVerdict = cb.canAct(fp, resourceKey, now);
  if (!cbVerdict.allowed) return `Can't run that right now — ${cbVerdict.reason}.`;
  cb.record(fp, resourceKey, now);

  try {
    const result = await executeAction(action);
    let backupRef: string | undefined;
    if (result.backupYaml) {
      const key = `${ts}_${fp}`.replace(/[^A-Za-z0-9_.-]/g, "_");
      backupRef = await storeBackup(cfg.backupsConfigMap, cfg.stateNamespace, key, result.backupYaml, cfg.maxBackups);
    }
    state = appendAudit(
      state,
      {
        at: ts, fingerprint: fp, incident: item.incident, proposal: action.label,
        command: result.commands.join(" && "), tier: tier === RiskTier.Medium ? "medium" : "low",
        verdict: "approved", outcome: result.success ? "success" : "failure",
        detail: truncate(`approved via Signal — ${result.output}`), backupRef,
      },
      cfg.auditMaxEntries,
    );
    // Drop the item from the queue whether or not the command succeeded — a
    // failed run is recorded in the audit log; re-queuing happens on re-detect.
    state = { ...state, queue: state.queue.filter((_, i) => i !== index) };
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    log(`${result.success ? "✓" : "✗"} approved-via-signal ${action.label} — ${result.commands.join(" && ")}`);
    return result.success
      ? `✓ Ran: ${action.label}\n${result.commands.join(" && ")}`
      : truncate(`✗ Failed: ${action.label}\n${result.output}`, 1200);
  } catch (e) {
    return `✗ Error running ${action.label}: ${String(e)}`;
  }
}

/** Local minutes-of-day (respects the container TZ env) for the quiet-hours window. */
function minOfDay(now: number): number {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

function record(state: AssistantState, cfg: Config, entry: AuditEntry): AssistantState {
  return appendAudit(state, entry, cfg.auditMaxEntries);
}

function queue(
  state: AssistantState,
  cfg: Config,
  at: string,
  fingerprint: string,
  incident: string,
  suggestion: string,
  reason: string,
  action?: SuggestedAction,
): AssistantState {
  const exists = state.queue.some((q) => q.incident === incident && q.suggestion === suggestion);
  if (exists) return state;
  return { ...state, queue: [{ at, fingerprint, incident, suggestion, reason, action }, ...state.queue].slice(0, cfg.auditMaxEntries) };
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

/** Best-effort flush of this tick's notifications to the configured channels. */
function flushNotifications(rc: RuntimeConfig, notifications: string[]): void {
  if (notifications.length === 0) return;
  const text = `Rigel assistant:\n${notifications.join("\n")}`;
  if (rc.webhookUrl) void notifyWebhook(rc.webhookUrl, text);
  if (rc.signalApiUrl && rc.signalNumber) {
    void notifySignal(rc.signalApiUrl, rc.signalNumber, rc.signalRecipients, text);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log(`starting v${VERSION} — worker=${cfg.workerModel} poll=${cfg.pollIntervalMs}ms`);
  log(`provider CLI self-check — ${formatSelfCheck(await runSelfCheck())}`);
  const cb = new CircuitBreaker({
    maxPerResourcePerHour: cfg.maxPerResourcePerHour,
    maxPerNight: cfg.maxPerNight,
    maxAttemptsPerIncident: cfg.maxAttemptsPerIncident,
    windowMs: cfg.windowMs,
  });
  const loop: LoopState = { streaks: new Map(), handled: new Set(), seen: new SeenTimestamps(), sessions: new SessionStore() };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick(cfg, cb, loop);
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
