import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { classifyRisk, RiskTier } from "./classifier.js";
import { evaluateAlertRules, emptyAlertState } from "./alerts.js";
import { loadConfig, resolveFixRunnerImage, type Config } from "./config.js";
import { readRuntimeConfig, decideAutonomy, type RuntimeConfig, type AutofixConfig } from "./runtimeConfig.js";
import { selectLogScanPods } from "./autofixScope.js";
import { resolveWorkloadRepo } from "./repoResolve.js";
import { resolveAutofixEligibility, type AutofixEligibility } from "./autofixEligibility.js";
import { dispatchRepoFix } from "./repoFixDispatch.js";
import { reconcileFixJobs, type FixReconcileDeps } from "./reconcileFixJobs.js";
import { FIX_LABEL, FIX_LABEL_VALUE } from "./fixJob.js";
import { notifyWebhook, notifySignal, receiveSignal, notifyMatrix, receiveMatrix, markMatrixRead, setMatrixTyping } from "./notify.js";
import { runDiagnosis } from "./diagnose.js";
import { SessionStore } from "./sessionStore.js";
import {
  handleInbound,
  HELP_TEXT,
  SeenTimestamps,
  type CommandHandlers,
  type InboundHandlers,
} from "./signalInbound.js";
import {
  handleMatrixInbound,
  SeenEventIds,
  type MatrixInboundHandlers,
} from "./matrixInbound.js";
import {
  detectDegradedDeployments,
  detectLogErrors,
  detectUnhealthyPods,
  fingerprint,
  type Incident,
} from "./detector.js";
import { kubectl, kubectlApply } from "./kubectl.js";
import { isRepoFixAction, toKubectlInvocations, type SuggestedAction } from "./action.js";
import type { RepoFixDeps } from "./repoFixDispatch.js";
import { runThreadedDiagnosis } from "./threadedDiagnosis.js";
import { runWorker } from "./worker.js";
import { diagnoseConfirmed } from "./diagnosePool.js";
import { runSupervisor, type SupervisorOutput } from "./supervisor.js";
import { executeAction } from "./executor.js";
import { CircuitBreaker } from "./guardrails.js";
import { runSelfCheck, formatSelfCheck } from "./selfCheck.js";
import {
  appendAudit,
  autoSilence,
  countFixPrBudget,
  dispositionFromAudit,
  readState,
  reconcileQueue,
  recordIncident,
  resolveIncident,
  storeBackup,
  touchIncident,
  writeState,
  type AssistantState,
  type AuditEntry,
} from "./state.js";
import { evaluateDigests } from "./digest.js";

const VERSION = "0.1.0";

// Bounds for the per-pod log-error scan (detectLogErrors). Both keep each
// `kubectl logs` cheap: only the recent tail, hard-capped in bytes.
const LOG_SCAN_TAIL_LINES = 200;
const LOG_SCAN_LIMIT_BYTES = 65536;

function log(msg: string): void {
  process.stdout.write(`[assistant] ${new Date().toISOString()} ${msg}\n`);
}

/** Bounded recent-log tail for the log-error scan. Returns null when logs can't
 * be read (RBAC, or a multi-container pod that needs `-c`), so that pod is
 * skipped. The default container is used; multi-container pods are skipped for
 * now (a Slice-1 limitation). */
async function tailPodLogs(namespace: string, podName: string): Promise<string | null> {
  const res = await kubectl([
    "logs",
    podName,
    "-n",
    namespace,
    `--tail=${LOG_SCAN_TAIL_LINES}`,
    `--limit-bytes=${LOG_SCAN_LIMIT_BYTES}`,
  ]);
  return res.code === 0 ? res.stdout : null;
}

function nsArgs(cfg: Config): string[] {
  // Always list cluster-wide, then filter — simpler than per-namespace fan-out.
  return ["-A"];
}

/** The fix-PR orchestration IO the dispatch seam needs: a dedup-check (does a fix
 *  Job already exist?) + manifest apply. Bundled here so a single tick reuses one
 *  object and tests can drive it through the same mocked kubectl. */
function repoFixDeps(): RepoFixDeps {
  return {
    jobExists: async (name, namespace) =>
      (await kubectl(["get", "job", name, "-n", namespace, "-o", "name"])).code === 0,
    apply: (manifest) => kubectlApply(manifest),
  };
}

/** The cluster IO the Phase-4 fix reconcile needs: list completed fix Jobs +
 *  read each one's pod termination message. Wired to the same kubectl as the rest
 *  of the loop so tests drive it through one mock. */
function fixReconcileDeps(cfg: Config): FixReconcileDeps {
  const ns = cfg.stateNamespace;
  return {
    listFixJobs: async () => {
      // Distinguish "list FAILED" (null) from "genuinely empty" ([]): a non-zero
      // exit (RBAC denial / API 429 / timeout) OR a spawn throw is unreadable, NOT
      // "no jobs". The budget cap depends on this to fail CLOSED (a failed list must
      // never read as zero in-flight); the reconcile treats null the same as before.
      try {
        const res = await kubectl(["get", "jobs", "-l", `${FIX_LABEL}=${FIX_LABEL_VALUE}`, "-n", ns, "-o", "json"]);
        return res.code === 0 ? itemsOf(safeParse(res.stdout)) : null;
      } catch {
        return null;
      }
    },
    readTerminationMessage: async (jobName) => {
      const res = await kubectl([
        "get", "pod", "-l", `job-name=${jobName}`, "-n", ns,
        "-o", "jsonpath={.items[0].status.containerStatuses[0].state.terminated.message}",
      ]);
      return res.code === 0 ? res.stdout : null;
    },
  };
}

/** Delete a reconciled fix Job + its spec ConfigMap (same `rigel-fix-<id>` name).
 *  Idempotent (--ignore-not-found) and best-effort — never throws into the loop. */
async function gcFixResources(cfg: Config, name: string): Promise<void> {
  try {
    await kubectl(["delete", "job", name, "-n", cfg.stateNamespace, "--ignore-not-found"]);
    await kubectl(["delete", "configmap", name, "-n", cfg.stateNamespace, "--ignore-not-found"]);
  } catch (e) {
    log(`fix GC error for ${name}: ${String(e)}`);
  }
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

async function detectAll(cfg: Config, autofix: AutofixConfig): Promise<{ incidents: Incident[]; pods: Record<string, unknown>[]; deps: Record<string, unknown>[]; podsOk: boolean; depsOk: boolean; logScanned: boolean }> {
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

  // Slice-1 bounded log scan: running pods the status checks didn't already flag
  // may be logging errors WITHOUT crashing. Gated to the autofix opt-in — OFF
  // means no log tailing at all (pre-2a behavior); ON tails only in-scope pods, so
  // the `kubectl logs --tail` calls are bounded to the small opted-in surface.
  // Matched signatures fingerprint/debounce exactly like status signals.
  let logScanned = false;
  if (podsRes.code === 0) {
    const scanPods = selectLogScanPods(autofix, pods);
    if (scanPods.length > 0) {
      logScanned = true;
      const flagged = new Set(
        incidents.filter((i) => i.incidentKind === "unhealthyPod").map((i) => `${i.namespace}/${i.name}`),
      );
      incidents.push(...(await detectLogErrors({ items: scanPods }, flagged, tailPodLogs)));
    }
  }
  log(
    `detect: pods exit=${podsRes.code} (${podsRes.stdout.length}b) deps exit=${depsRes.code} (${depsRes.stdout.length}b) → ${incidents.length} incident(s) before filter` +
      (incidents.length ? `: ${incidents.map((i) => `${i.namespace}/${i.name}:${i.reason}`).join(", ")}` : "") +
      (podsRes.code !== 0 ? ` | pods stderr: ${podsRes.stderr.slice(0, 200)}` : ""),
  );
  // (namespace filtering moved to tick() so it uses the LIVE rc.limits.namespaces)
  return { incidents, pods, deps, podsOk: podsRes.code === 0, depsOk: depsRes.code === 0, logScanned };
}

export interface LoopState {
  streaks: Map<string, number>;
  handled: Set<string>;
  /** Inbound Signal messages already processed, so none is answered twice. */
  seen: SeenTimestamps;
  /** Inbound Matrix events already processed, so none is answered twice. */
  seenMatrix: SeenEventIds;
  /** Persisted /sync cursor — undefined until the first Matrix inbound poll. */
  matrixSince?: string;
  /** Per-sender claude diagnosis threads (1-hour idle reset, in-memory). */
  sessions: SessionStore;
}

export async function tick(
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
  // Count of incidents NEWLY auto-silenced this tick — drives an edge-triggered
  // refresh of the operator report's auto-silence line (see end of tick).
  let newlySilenced = 0;
  state = {
    ...state,
    updatedAt: ts,
    status: { heartbeatAt: ts, enabled: rc.enabled, version: VERSION },
  };

  // ---- OBSERVE (always runs, even when the kill-switch is off) ----
  // Detection + the rolling incident history + scheduled digests must stay live
  // while remediation is paused, so this is no longer gated on rc.enabled — only the
  // remediate phase below is. Drop incidents the operator has silenced (known noise)
  // — no detection, no action on those fingerprints. The agent's own auto-silence set
  // (benign incidents the worker judged "acceptable") is unioned in so they don't
  // re-fire.
  const detection = await detectAll(cfg, rc.autofix);
  // Live namespace scope from rc.limits (was deploy-time cfg.namespaces in detectAll).
  const nsAllow = rc.limits.namespaces;
  const scoped = nsAllow.length > 0
    ? detection.incidents.filter((i) => i.namespace === "" || nsAllow.includes(i.namespace))
    : detection.incidents;
  const autoSilenced = new Set(state.autoSilenced ?? []);
  const incidents = scoped.filter((i) => {
    const fp = fingerprint(i);
    return !rc.silenced.has(fp) && !autoSilenced.has(fp);
  });

  const present = new Set(incidents.map(fingerprint));
  // Recovered incidents fall out of the debounce/handled tracking so a fresh
  // recurrence re-triggers — and any open history record is marked resolved.
  for (const fp of [...loop.streaks.keys()]) {
    if (!present.has(fp)) {
      state = resolveIncident(state, fp, ts);
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

  // Note every confirmed incident in the rolling history (create as "flagged" if
  // new, else just refresh lastSeenAt). touchIncident NEVER downgrades a disposition
  // the remediate phase set via record(), so this is safe to run every tick.
  for (const i of confirmed) {
    const fp = fingerprint(i);
    state = touchIncident(state, {
      at: ts, lastSeenAt: ts, fingerprint: fp,
      location: shortFingerprint(fp), reason: fp.split("|")[3] ?? "",
    });
  }

  // Fix-Job GC list is produced by the remediate phase but consumed after the
  // durable write below, so it lives in the tick scope (not the remediate block).
  let fixGc: string[] = [];
  if (rc.enabled) {
    // Re-validate the approval queue against live detection: auto-clear queued
    // suggestions whose incident has cleared (or whose resource is gone), so the
    // queue stays trustworthy.
    {
      const presentNow = new Set(incidents.map(fingerprint));
      const checkedKinds = new Set<string>();
      if (detection.podsOk) checkedKinds.add("unhealthyPod");
      // Only treat loggedError absence as "resolved" when the log scan actually ran
      // this tick (autofix on + in-scope pods); otherwise a disabled/skipped scan
      // would wrongly auto-clear a previously-queued loggedError item.
      if (detection.logScanned) checkedKinds.add("loggedError");
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

    if (incidents.length > 0) {
      log(`tick: ${incidents.length} present, confirmPolls=${rc.limits.confirmPolls}, streaks=[${[...loop.streaks.entries()].map(([k, v]) => `${k}=${v}`).join("; ")}], ${confirmed.length} confirmed, ${loop.handled.size} handled`);
    }
    if (confirmed.length > 0) log(`handling ${confirmed.length} confirmed incident(s)`);

    // Resolve autofix eligibility ONCE per confirmed incident: the owning-Deployment
    // walk (pod→ReplicaSet→Deployment for pod incidents) + the scope check + the
    // GitOps-source lookup. Used twice: Stage A tells the worker it MAY open a fix PR
    // (only when a source actually resolved), and Stage B reuses it to route an
    // openFixPR proposal without re-resolving — and without the 2b bug of treating a
    // pod name as a Deployment name. Short-circuits to no cluster IO when autofix is
    // off / out of scope, so this is cheap when autofix isn't in play.
    const eligibility = new Map<string, AutofixEligibility>(
      await Promise.all(
        confirmed.map(async (incident) => {
          let e: AutofixEligibility;
          try {
            e = await resolveAutofixEligibility(rc.autofix, incident, detection.pods, {
              resolveRepo: (ns, dep) => resolveWorkloadRepo({ kubectl }, ns, dep, cfg.stateNamespace),
            });
          } catch (err) {
            // Conservative bias: a resolve failure (e.g. a kubectl spawn error that
            // REJECTS, not just a non-zero exit) ⇒ not eligible ⇒ no PR. Never let it
            // abort the tick — the rest of remediation (the verdict-independent
            // kubectl path for every confirmed incident) must still run.
            log(`eligibility resolve failed for ${fingerprint(incident)} — treating as not eligible: ${String(err)}`);
            e = { inScope: false, repo: null };
          }
          return [fingerprint(incident), e] as const;
        }),
      ),
    );

    // Stage A: investigate every confirmed incident concurrently (bounded). The
    // Worker model call is the slow, side-effect-free part, so overlapping the
    // calls cuts wall-clock when several incidents land in one tick. The
    // deterministic guardrails stay in Stage B below.
    const packets = await diagnoseConfirmed(
      {
        diagnose: (incident) => runWorker(rc, [incident], eligibility.get(fingerprint(incident))?.repo ?? null),
        limit: cfg.maxConcurrentDiagnoses,
      },
      confirmed,
    );

    // Per-day fix-PR budget baseline, computed ONCE per tick before any dispatch:
    // real opened PRs still inside the rolling 24h window PLUS the fix Jobs currently
    // in flight (dispatched a prior tick, not yet reconciled into pullRequests). New
    // dispatches this tick are added via fixPrsDispatchedThisTick below, so the cap
    // holds even before the reconcile records them. The Jobs are listed ONCE (not
    // re-listed per dispatch) to dodge read-after-write races; the in-tick counter
    // covers same-tick dispatches. Independent of the kubectl circuit breaker (that
    // caps per-resource-per-hour cluster mutations; this caps PR creation per day).
    let fixBudgetBaseline = 0;
    let fixPrsDispatchedThisTick = 0;
    // Fail CLOSED: if the in-flight Job list can't be read this tick we can't verify
    // how many fixes are already pending, so we DEFER all fix-PR dispatch rather than
    // assume zero in-flight (which could open up to ~2x the cap). A non-zero exit
    // (RBAC / 429 / timeout) or a spawn throw both surface as `null` from listFixJobs
    // — a failed list is a DISTINCT call+verb from the dedup `get job` + `apply`, so it
    // does NOT imply create would fail; assuming so was the I1 over-open hole.
    let fixListUnreadable = false;
    if (rc.autofix.enabled && confirmed.length > 0) {
      let inFlight: unknown[] | null;
      try {
        inFlight = await fixReconcileDeps(cfg).listFixJobs();
      } catch {
        inFlight = null;
      }
      if (inFlight === null) {
        fixListUnreadable = true;
      } else {
        fixBudgetBaseline = countFixPrBudget(state.pullRequests, inFlight.length, now);
      }
    }

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
        // Fail closed: a worker THROW never results in an action.
        const msg = packet.error;
        state = workerAuthReport(state, msg);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
          outcome: "failure", detail: `worker failed (fail-closed): ${msg}`,
        });
        continue;
      }

      const analysis = packet.analysis;
      const actions = packet.actions;

      if (packet.failed) {
        // The worker model call FAILED (provider/credential error) — NOT a triage.
        // Record low-noise (skipped) and never act; surface an auth lapse loudly.
        state = workerAuthReport(state, packet.verdictReason || analysis);
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
          outcome: "skipped", detail: `worker unavailable (fail-closed): ${truncate(packet.verdictReason || analysis)}`,
        });
        continue;
      }

      // Verdict-based SUPPRESSION (auto-silence / queue-note) applies ONLY to
      // `loggedError` incidents — the log-scan signals where a benign or uncertain
      // triage is the whole point of asking the worker. A STATUS incident
      // (unhealthyPod / degradedDeployment) is NEVER silenced or queued because of
      // the verdict: its kubectl remediation runs verdict-independently below, exactly
      // as it did before triage existed. (The verdict still further gates an
      // `openFixPR` for any kind — handled per-action.)
      if (incident.incidentKind === "loggedError") {
        if (packet.verdict === "acceptable") {
          // Benign/expected — auto-silence the fingerprint so it doesn't re-fire.
          if (!(state.autoSilenced ?? []).includes(fp)) newlySilenced++;
          state = autoSilence(state, fp);
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
            outcome: "skipped", detail: `acceptable — auto-silenced: ${truncate(packet.verdictReason || analysis)}`,
            analysis: truncate(analysis),
          });
          log(`acceptable → silenced ${fp}`);
          continue;
        }
        if (packet.verdict === "uncertain") {
          // Not confident enough to act — queue a low-noise note for a human, no
          // notification, no autonomous action (even if an action was proposed).
          const note = packet.verdictReason.trim() || "uncertain — needs a human look";
          state = queue(state, cfg, ts, fp, describe(incident), note, "uncertain — flagged for review");
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: note, tier: "low",
            outcome: "queued", detail: `uncertain: ${truncate(packet.verdictReason || analysis)}`, analysis: truncate(analysis),
          });
          continue;
        }
      }

      // Remediation. A kubectl action executes regardless of the verdict (the
      // classifier / circuit breaker / MEDIUM supervisor below are the real safety
      // net); an `openFixPR` additionally requires an "actionable" verdict (gated in
      // its own branch). No proposed action ⇒ nothing to do (skipped, low-noise).
      if (!actions || actions.length === 0) {
        state = record(state, cfg, {
          at: ts, fingerprint: fp, incident: describe(incident), tier: "low",
          outcome: "skipped", detail: truncate(analysis),
        });
        continue;
      }

      const action = actions[0]!;

      // Repo-fix proposals (openFixPR) never mutate the cluster — they open a PR
      // against the workload's GitOps source. They are routed entirely off the
      // kubectl/preview path (previewCommand / executeAction THROW for openFixPR), so
      // an openFixPR can NEVER reach the kubectl executor. Gating, in order:
      //   1. the verdict must be "actionable" — a non-actionable verdict means no PR;
      //   2. the proposal must be DISPATCHABLE (in scope + a resolved GitOps source) —
      //      otherwise dispatchRepoFix records the precise skip and no review is spent;
      //   3. the adversarial fix-quality supervisor (buildFixPrompt) must APPROVE the
      //      proposed file change before a PR is opened on the user's behalf —
      //      reject ⇒ skip, escalate / supervisor-error ⇒ queue for a human.
      // Eligibility is reused from Stage A (the owning-Deployment walk), not
      // re-derived from the action (which mistook a pod name for a Deployment — 2b).
      if (isRepoFixAction(action.kind)) {
        if (packet.verdict !== "actionable") {
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label, tier: "medium",
            outcome: "skipped",
            detail: `openFixPR proposed, but the worker verdict was "${packet.verdict}" (not actionable) — no PR`,
            analysis: truncate(analysis),
          });
          continue;
        }
        const e = eligibility.get(fp) ?? { inScope: false, repo: null };
        if (!e.inScope || !e.repo) {
          // Not dispatchable (autofix off / out of scope / not GitOps-tracked): let
          // dispatchRepoFix record the exact skip — an adversarial review of a fix
          // that can never open a PR would be wasted. The early-return skip guards
          // run BEFORE any Job/ConfigMap creation, so this path never creates a Job.
          const outcome = await dispatchRepoFix(repoFixDeps(), state, {
            at: ts, fingerprint: fp, incident: describe(incident), action, analysis,
            repo: e.repo, inScope: e.inScope, auditMaxEntries: cfg.auditMaxEntries,
            namespace: cfg.stateNamespace, image: cfg.fixRunnerImage,
          });
          state = outcome.state;
          if (outcome.notification) notifications.push(outcome.notification);
          continue;
        }
        // Per-day fix-PR budget cap: at most rc.autofix.maxPerDay opened PRs in a
        // rolling 24h. Checked BEFORE the fix-quality supervisor so an exhausted
        // budget never spends an Opus review, and BEFORE any Job is created, so we
        // can never open more than the cap. An unreadable in-flight list defers ALL
        // dispatch this tick (fail closed). Skipped fixes are recorded for the audit.
        const cap = rc.autofix.maxPerDay;
        if (fixListUnreadable || fixBudgetBaseline + fixPrsDispatchedThisTick >= cap) {
          const detail = fixListUnreadable
            ? "fix-PR budget unverifiable (the in-flight fix-Job list was unreadable this tick): deferring"
            : `daily fix-PR budget reached (${cap}/${cap}): not opening another fix PR until a slot frees up`;
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
            tier: "medium", outcome: "skipped", detail, analysis: truncate(analysis),
          });
          log(fixListUnreadable
            ? `fix-PR budget unverifiable (in-flight Job list unreadable); skipping ${action.label}`
            : `fix-PR budget reached (${cap}/${cap}); skipping ${action.label}`);
          continue;
        }
        // Dispatchable: the fix-quality supervisor judges the PROPOSED FILE CHANGE
        // (root-cause / minimal / safe-to-merge), NOT a kubectl command — pass an
        // empty command so previewCommand (which THROWS for openFixPR) is never run.
        let sup: SupervisorOutput;
        try {
          sup = await runSupervisor(rc, incident, action, analysis, "");
        } catch (err) {
          // Fail closed: supervisor unreachable / malformed verdict → never open a PR.
          state = queue(state, cfg, ts, fp, describe(incident), action.label, "fix PR — supervisor error (fail-closed)", action);
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
            tier: "medium", verdict: "escalated", outcome: "queued",
            detail: `fix-quality supervisor failed (fail-closed): ${String(err)}`,
          });
          continue;
        }
        if (sup.verdict.decision === "reject") {
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
            tier: "medium", verdict: "rejected", outcome: "skipped",
            detail: `Opus rejected the fix (conf ${sup.verdict.confidence.toFixed(2)}): ${sup.verdict.reason}`, analysis: truncate(analysis),
          });
          continue;
        }
        if (sup.verdict.decision === "escalate") {
          state = queue(state, cfg, ts, fp, describe(incident), action.label, `fix PR — Opus escalated: ${sup.verdict.reason}`, action);
          state = record(state, cfg, {
            at: ts, fingerprint: fp, incident: describe(incident), proposal: action.label,
            tier: "medium", verdict: "escalated", outcome: "queued",
            detail: `Opus escalated the fix (conf ${sup.verdict.confidence.toFixed(2)}): ${sup.verdict.reason}`, analysis: truncate(analysis),
          });
          notifications.push(`▸ Needs approval (Opus escalated fix PR): ${action.label} — ${describe(incident)}`);
          continue;
        }
        // approve → create the fix ConfigMap + Job via the seam (dispatchRepoFix
        // queues it pending the fix-runner, which opens the actual PR).
        log(`Opus approved fix PR (conf ${sup.verdict.confidence.toFixed(2)}): ${action.label}`);
        const outcome = await dispatchRepoFix(repoFixDeps(), state, {
          at: ts, fingerprint: fp, incident: describe(incident), action, analysis,
          repo: e.repo, inScope: e.inScope, auditMaxEntries: cfg.auditMaxEntries,
          namespace: cfg.stateNamespace, image: cfg.fixRunnerImage,
        });
        state = outcome.state;
        if (outcome.notification) {
          notifications.push(outcome.notification);
          // A fix is now in flight (Job created, or already existed) — charge it to
          // the rolling budget so further dispatches THIS tick respect the cap.
          fixPrsDispatchedThisTick++;
        }
        continue;
      }

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
        let sup: SupervisorOutput;
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

    // Phase-4 loop close: reconcile any FINISHED fix-runner Jobs — record the opened
    // PR (or the failure) and surface a notification. Recording happens BEFORE the
    // durable state write below; GC happens AFTER it, so a crash mid-reconcile
    // re-processes a still-present Job (dedup-safe) instead of losing an opened PR.
    try {
      const recon = await reconcileFixJobs(fixReconcileDeps(cfg), state, {
        at: ts, auditMaxEntries: cfg.auditMaxEntries,
      });
      state = recon.state;
      notifications.push(...recon.notifications);
      fixGc = recon.gc;
    } catch (e) {
      log(`fix reconcile error: ${String(e)}`);
    }

    // Surface auto-silence in the operator report so suppressed-but-benign issues
    // aren't invisible (the raw audit was the only signal before). Edge-triggered —
    // only when something was NEWLY silenced this tick — so a manual "Clear" isn't
    // instantly undone by the persistent auto-silence set. The line is refreshed in
    // place (prior one stripped) and everything else (e.g. a sticky worker-credential
    // warning) is preserved.
    if (newlySilenced > 0) {
      state = { ...state, report: withAutoSilenceLine(state.report, state.autoSilenced ?? []) };
    }
  } else {
    log("kill-switch is off — observing only (digests still run)");
  }

  // ---- REPORT (always runs) ----
  // Evaluate scheduled digests (arm new ones / send due ones) and persist their
  // send-state in the SAME durable write, so a digest still fires on schedule even
  // while remediation is paused.
  state = await evaluateDigests(rc, state, detection, now);
  await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);

  if (rc.enabled) {
    // GC reconciled fix resources AFTER the durable state write (idempotent deletes).
    for (const name of fixGc) await gcFixResources(cfg, name);

    // Best-effort outbound notification for what happened this tick.
    flushNotifications(rc, notifications);

    // Two-way Signal: answer any inbound diagnosis questions / approval commands.
    // Gated on the kill-switch and the explicit signalInbound opt-in. Never throws —
    // failures stay out of the loop.
    if (rc.signalInbound && rc.signalApiUrl && rc.signalNumber) {
      try {
        await handleSignalInbound(cfg, rc, cb, loop);
      } catch (e) {
        log(`signal inbound error: ${String(e)}`);
      }
    }

    // Two-way Matrix: independent of Signal — runs if enabled, never blocks it.
    if (rc.matrix.inbound && rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
      try {
        await handleMatrixInboundIO(cfg, rc, cb, loop);
      } catch (e) {
        log(`matrix inbound error: ${String(e)}`);
      }
    }
  }
}

/** The transport-agnostic command handlers (help/status/queue/approve/diagnose),
 *  shared by the Signal and Matrix inbound loops. `approve` runs a queued,
 *  supervised fix through the same circuit breaker + backup path as the loop. */
function buildCommandHandlers(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): CommandHandlers {
  return {
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
    ...buildCommandHandlers(cfg, rc, cb, loop),
  };

  await handleInbound({ enabled: true, apiUrl: rc.signalApiUrl, number: rc.signalNumber, allow }, handlers, loop.seen);
}

/** Wire the real IO handlers and run one Matrix inbound poll. Allowlist: explicit
 *  allowed senders, else fall back to the bot's own id. Persists the /sync cursor
 *  to assistant-state so a restart resumes cleanly. */
async function handleMatrixInboundIO(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): Promise<void> {
  const m = rc.matrix;
  const allow = m.allowedSenders;
  if (allow.length === 0) {
    log("matrix inbound: no authorized senders configured — skipping");
    return;
  }
  if (loop.matrixSince === undefined) {
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    loop.matrixSince = s.matrixSince;
  }
  const handlers: MatrixInboundHandlers = {
    sync: (since) => receiveMatrix(m.homeserverUrl!, m.accessToken!, since),
    reply: (text) => notifyMatrix(m.homeserverUrl!, m.accessToken!, m.roomId!, text),
    markRead: (eventId) => markMatrixRead(m.homeserverUrl!, m.accessToken!, m.roomId!, eventId),
    setTyping: (typing) => setMatrixTyping(m.homeserverUrl!, m.accessToken!, m.roomId!, m.userId ?? "", typing),
    ...buildCommandHandlers(cfg, rc, cb, loop),
  };
  const next = await handleMatrixInbound(
    { enabled: true, homeserverUrl: m.homeserverUrl, accessToken: m.accessToken, roomId: m.roomId, allow, botUserId: m.userId, since: loop.matrixSince },
    handlers,
    loop.seenMatrix,
  );
  if (next !== loop.matrixSince) {
    loop.matrixSince = next;
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, { ...s, matrixSince: next });
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
    return `"${item.suggestion}" can't be run automatically (destructive / RBAC-blocked). Run it from Rigel.`;
  }
  const action = item.action;
  if (isRepoFixAction(action.kind)) {
    // Repo-fix items open a PR via the fix-runner — they are NOT kubectl commands
    // and must never reach executeAction (which throws for them).
    return `"${item.suggestion}" opens a fix PR and is handled automatically by the fix-runner — it isn't a command to run from here.`;
  }
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
  let next = appendAudit(state, entry, cfg.auditMaxEntries);
  // Mirror the disposition into the rolling incident history so a digest can
  // describe what was acted on, not only what was observed. Upserts by fingerprint
  // (the observe phase already created a "flagged" record via touchIncident), so a
  // remediation outcome UPGRADES it (flagged → autoFixed/queued/failed) in place.
  next = recordIncident(next, {
    at: entry.at, lastSeenAt: entry.at, fingerprint: entry.fingerprint,
    location: shortFingerprint(entry.fingerprint), reason: entry.fingerprint.split("|")[3] ?? "",
    disposition: dispositionFromAudit(entry),
    note: entry.proposal,
  });
  return next;
}

/** Surface a loud report when the worker provider's credential is failing (an
 * expired Claude token, a bad API key, etc.). Provider-agnostic: the Assistant
 * tab shows which provider each role uses and where to update its credential.
 * A no-op for non-auth failures. Fires for BOTH a thrown worker error and a
 * fail-closed (isError) provider/credential error. */
function workerAuthReport(state: AssistantState, msg: string): AssistantState {
  if (!/auth|oauth|401|token|unauthor/i.test(msg)) return state;
  return {
    ...state,
    report: `⚠️ The worker AI's credentials are failing (auth error). Update the worker provider's key/token in the Assistant tab. (${msg})`,
  };
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

/** A compact `namespace/name` for an incident fingerprint (kind|ns|name|reason),
 *  falling back to the raw fingerprint when it isn't in that shape. */
function shortFingerprint(fp: string): string {
  const p = fp.split("|");
  return p.length >= 3 && p[1] && p[2] ? `${p[1]}/${p[2]}` : fp;
}

const AUTO_SILENCE_PREFIX = "Auto-silenced ";

/** Refresh the report's single auto-silence summary line: strip any prior one
 *  (so it never accumulates), preserve every other line, and append the current
 *  count + a short list of the newest few. Returns the report unchanged-in-shape
 *  when the set is empty (just the prior non-auto-silence lines). Pure. */
function withAutoSilenceLine(report: string | undefined, silenced: string[]): string {
  const kept = (report ?? "").split("\n").filter((l) => l !== "" && !l.startsWith(AUTO_SILENCE_PREFIX));
  if (silenced.length > 0) {
    const shown = silenced.slice(0, 3).map(shortFingerprint).join(", ");
    const more = silenced.length > 3 ? `, +${silenced.length - 3} more` : "";
    kept.push(`${AUTO_SILENCE_PREFIX}${silenced.length} benign issue(s): ${shown}${more}`);
  }
  return kept.join("\n");
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
  if (rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
    void notifyMatrix(rc.matrix.homeserverUrl, rc.matrix.accessToken, rc.matrix.roomId, text);
  }
}

/** Fresh in-memory loop state for a run. Exported so tests can drive `tick`. */
export function createLoopState(): LoopState {
  return {
    streaks: new Map(),
    handled: new Set(),
    seen: new SeenTimestamps(),
    seenMatrix: new SeenEventIds(),
    sessions: new SessionStore(),
  };
}

async function main(): Promise<void> {
  const base = loadConfig();
  // Run fix Jobs on the agent's OWN running image (resolved once at startup), not
  // the RIGEL_FIX_RUNNER_IMAGE env — CI's `kubectl set image` updates the running
  // image but not that env, so it drifts stale. Falls back to the env on failure.
  const fixRunnerImage = await resolveFixRunnerImage(base, { kubectl, hostname: process.env.HOSTNAME, log });
  if (fixRunnerImage !== base.fixRunnerImage) {
    log(`fix-runner image resolved to the agent's running image: ${fixRunnerImage}`);
  }
  const cfg: Config = { ...base, fixRunnerImage };
  log(`starting v${VERSION} — worker=${cfg.workerModel} poll=${cfg.pollIntervalMs}ms`);
  log(`provider CLI self-check — ${formatSelfCheck(await runSelfCheck())}`);
  const cb = new CircuitBreaker({
    maxPerResourcePerHour: cfg.maxPerResourcePerHour,
    maxPerNight: cfg.maxPerNight,
    maxAttemptsPerIncident: cfg.maxAttemptsPerIncident,
    windowMs: cfg.windowMs,
  });
  const loop = createLoopState();

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

// Only start the poll loop when executed directly (node dist/index.js /
// tsx src/index.ts). Imported (e.g. by tests) this module exports `tick`/
// `createLoopState` without starting the loop. `process.argv[1]` preserves
// symlinks while `import.meta.url` is realpath-resolved by the loader, so
// compare realpaths — otherwise a symlinked launch path silently no-ops main().
const entryArg = process.argv[1];
const entryPath = entryArg ? realpathSync(entryArg) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(`fatal: ${String(e)}`);
    process.exit(1);
  });
}
