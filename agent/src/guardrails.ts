/**
 * Deterministic guardrails — the hard floor that sits underneath every model.
 * These are dumb, unbreakable limits: no prompt can talk its way past them.
 *
 * Time is injected (`now` in epoch ms) rather than read from the clock, so the
 * logic is fully deterministic and testable.
 */

export interface CircuitBreakerConfig {
  /** Max actions against one resource within a rolling hour. */
  maxPerResourcePerHour: number;
  /** Max actions total within `windowMs` (the "nightly" cap). */
  maxPerNight: number;
  /** Stop acting on the same incident fingerprint after this many attempts —
   * prevents restart/rollback thrash loops on an unfixable problem. */
  maxAttemptsPerIncident: number;
  /** Rolling window for the nightly total cap. Defaults to 24h. */
  windowMs: number;
}

interface ActionRecord {
  fingerprint: string;
  resourceKey: string;
  at: number;
}

export interface Verdict {
  allowed: boolean;
  reason?: string;
}

const HOUR_MS = 3_600_000;

export class CircuitBreaker {
  private readonly history: ActionRecord[] = [];

  constructor(private cfg: CircuitBreakerConfig) {}

  /**
   * Update the live caps in place, preserving the action history. Only defined
   * fields are applied (a partial update keeps the rest). windowMs is deploy-time
   * and not part of the user-exposed OperationalLimits, so it is not changed here.
   * Called each tick from the runtime config so a limit edit goes live next poll.
   */
  updateLimits(limits: {
    maxPerResourcePerHour?: number;
    maxPerNight?: number;
    maxAttemptsPerIncident?: number;
  }): void {
    if (limits.maxPerResourcePerHour !== undefined) this.cfg.maxPerResourcePerHour = limits.maxPerResourcePerHour;
    if (limits.maxPerNight !== undefined) this.cfg.maxPerNight = limits.maxPerNight;
    if (limits.maxAttemptsPerIncident !== undefined) this.cfg.maxAttemptsPerIncident = limits.maxAttemptsPerIncident;
  }

  /** Decide whether an action may run now, without recording it. */
  canAct(fingerprint: string, resourceKey: string, now: number): Verdict {
    const sinceHour = now - HOUR_MS;
    const sinceWindow = now - this.cfg.windowMs;

    const incidentAttempts = this.history.filter(
      (r) => r.fingerprint === fingerprint && r.at >= sinceWindow,
    ).length;
    if (incidentAttempts >= this.cfg.maxAttemptsPerIncident) {
      return {
        allowed: false,
        reason: `circuit-breaker: ${incidentAttempts} prior attempts on this incident (max ${this.cfg.maxAttemptsPerIncident})`,
      };
    }

    const resourceActions = this.history.filter(
      (r) => r.resourceKey === resourceKey && r.at >= sinceHour,
    ).length;
    if (resourceActions >= this.cfg.maxPerResourcePerHour) {
      return {
        allowed: false,
        reason: `circuit-breaker: resource ${resourceKey} hit its hourly cap (${this.cfg.maxPerResourcePerHour})`,
      };
    }

    const nightlyActions = this.history.filter((r) => r.at >= sinceWindow).length;
    if (nightlyActions >= this.cfg.maxPerNight) {
      return {
        allowed: false,
        reason: `circuit-breaker: nightly total cap reached (${this.cfg.maxPerNight})`,
      };
    }

    return { allowed: true };
  }

  /** Record that an action was taken. Call after a successful or attempted run. */
  record(fingerprint: string, resourceKey: string, now: number): void {
    this.history.push({ fingerprint, resourceKey, at: now });
  }
}
