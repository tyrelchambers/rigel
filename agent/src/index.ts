import { classifyRisk, RiskTier } from "./classifier.js";
import { loadConfig, type Config } from "./config.js";
import { readRuntimeConfig, decideAutonomy, type RuntimeConfig } from "./runtimeConfig.js";
import { notifyWebhook, notifySignal, receiveSignal } from "./notify.js";
import { runDiagnosis } from "./diagnose.js";
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
  log(
    `detect: pods exit=${pods.code} (${pods.stdout.length}b) deps exit=${deps.code} (${deps.stdout.length}b) → ${incidents.length} incident(s) before filter` +
      (incidents.length ? `: ${incidents.map((i) => `${i.namespace}/${i.name}:${i.reason}`).join(", ")}` : "") +
      (pods.code !== 0 ? ` | pods stderr: ${pods.stderr.slice(0, 200)}` : ""),
  );
  if (cfg.namespaces.length > 0) {
    const allow = new Set(cfg.namespaces);
    incidents = incidents.filter((i) => i.namespace === "" || allow.has(i.namespace));
  }
  return incidents;
}

interface LoopState {
  streaks: Map<string, number>;
  handled: Set<string>;
  /** Inbound Signal messages already processed, so none is answered twice. */
  seen: SeenTimestamps;
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

  // Align the spend cap to the billing month (resets the running total when the
  // month rolls over, mirroring the non-rolling monthly Agent SDK credit).
  spend.syncMonth(monthKey(now));

  const rc = await readRuntimeConfig(cfg);
  const notifications: string[] = [];
  state = {
    ...state,
    updatedAt: ts,
    status: { heartbeatAt: ts, spentUsd: spend.total(), spendCapUsd: cfg.spendCapUsd, enabled: rc.enabled, version: VERSION },
    spend: { month: spend.currentMonth(), spentUsd: spend.total() },
  };

  if (!rc.enabled) {
    log("kill-switch is off — idle");
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    return;
  }
  if (!spend.canSpend()) {
    log(`spend cap reached ($${cfg.spendCapUsd}) — idle (fail-closed)`);
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
    return;
  }

  // Drop incidents the operator has silenced (known noise) — no detection,
  // no spend, no action on those fingerprints.
  const incidents = (await detectAll(cfg)).filter((i) => !rc.silenced.has(fingerprint(i)));
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

  if (incidents.length > 0) {
    log(`tick: ${incidents.length} present, confirmPolls=${cfg.confirmPolls}, streaks=[${[...loop.streaks.entries()].map(([k, v]) => `${k}=${v}`).join("; ")}], ${confirmed.length} confirmed, ${loop.handled.size} handled`);
  }
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
        tier: "blocked", outcome: "queued", detail: "queued for human (destructive)", analysis: truncate(analysis),
      });
      notifications.push(`▸ Needs approval (destructive): ${action.label} — ${describe(incident)}`);
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
      state = queue(state, cfg, ts, describe(incident), action.label, why, action);
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

  // Refresh the spend snapshot to include anything spent during this tick.
  if (state.status) state.status.spentUsd = spend.total();
  state.spend = { month: spend.currentMonth(), spentUsd: spend.total() };
  await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);

  // Best-effort outbound notification for what happened this tick.
  if (notifications.length > 0) {
    const text = `Helmsman assistant:\n${notifications.join("\n")}`;
    if (rc.webhookUrl) void notifyWebhook(rc.webhookUrl, text);
    if (rc.signalApiUrl && rc.signalNumber) {
      void notifySignal(rc.signalApiUrl, rc.signalNumber, rc.signalRecipients, text);
    }
  }

  // Two-way Signal: answer any inbound diagnosis questions / approval commands.
  // Gated on the kill-switch (we already returned above when disabled) and the
  // explicit signalInbound opt-in. Never throws — failures stay out of the loop.
  if (rc.signalInbound && rc.signalApiUrl && rc.signalNumber) {
    try {
      await handleSignalInbound(cfg, rc, spend, cb, loop);
    } catch (e) {
      log(`signal inbound error: ${String(e)}`);
    }
  }
}

/** Wire the real IO handlers and run one inbound poll. Read-only diagnosis is
 * metered against the spend cap; `approve` runs a previously-queued, supervised
 * fix through the same circuit breaker + backup path as the autonomous loop. */
async function handleSignalInbound(
  cfg: Config,
  rc: RuntimeConfig,
  spend: SpendTracker,
  cb: CircuitBreaker,
  loop: LoopState,
): Promise<void> {
  // Allowlist: explicit recipients, else fall back to the linked number itself.
  const allow = rc.signalRecipients.length > 0 ? rc.signalRecipients : rc.signalNumber ? [rc.signalNumber] : [];
  if (allow.length === 0) {
    log("signal inbound: no authorized numbers configured — skipping");
    return;
  }
  const spentBefore = spend.total();

  const handlers: InboundHandlers = {
    receive: (apiUrl, number) => receiveSignal(apiUrl, number),
    reply: (to, text) => notifySignal(rc.signalApiUrl!, rc.signalNumber!, [to], text),
    help: () => HELP_TEXT,
    status: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      const enabled = s.status?.enabled ? "active" : "disabled";
      const spent = s.status ? `$${s.status.spentUsd.toFixed(2)}/$${s.status.spendCapUsd}` : "—";
      return `Helmsman assistant is ${enabled}. Spend ${spent} this month. ${s.queue.length} fix(es) queued. Updated ${s.updatedAt || "—"}.`;
    },
    queue: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      if (s.queue.length === 0) return "No fixes are queued.";
      const lines = s.queue
        .slice(0, 10)
        .map((q, i) => `${i + 1}. ${q.suggestion} — ${q.incident}${q.action ? "" : " (manual; run in Helmsman)"}`);
      return `${lines.join("\n")}\n\nReply "approve N" to run one.`;
    },
    approve: (index) => approveQueued(cfg, cb, index),
    diagnose: async (question) => {
      if (!spend.canSpend()) {
        return "I've reached my monthly spend cap, so I can't investigate right now.";
      }
      const out = await runDiagnosis(cfg, question);
      spend.add(out.costUsd);
      return out.text || "I couldn't find anything conclusive — try asking more specifically.";
    },
    log,
  };

  await handleInbound({ enabled: true, apiUrl: rc.signalApiUrl, number: rc.signalNumber, allow }, handlers, loop.seen);

  // Persist spend if a diagnosis cost anything, so the cap survives restarts.
  if (spend.total() !== spentBefore) {
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    if (s.status) s.status.spentUsd = spend.total();
    s.spend = { month: spend.currentMonth(), spentUsd: spend.total() };
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, s);
  }
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
    return `"${item.suggestion}" can't be run automatically (destructive / RBAC-blocked). Run it from Helmsman.`;
  }
  const action = item.action;
  const tier = classifyRisk(action.kind);
  if (tier === RiskTier.Blocked) {
    return `"${item.suggestion}" is blocked from automatic execution. Run it from Helmsman.`;
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

function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
  const loop: LoopState = { streaks: new Map(), handled: new Set(), seen: new SeenTimestamps() };

  // Restore persisted spend so the monthly cap survives pod restarts.
  try {
    const persisted = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    if (persisted.spend) {
      spend.restore(persisted.spend.spentUsd, persisted.spend.month);
      log(`restored spend $${persisted.spend.spentUsd.toFixed(2)} for ${persisted.spend.month}`);
    }
  } catch {
    // no persisted state yet — start fresh
  }

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
