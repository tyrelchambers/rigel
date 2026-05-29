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

  constructor(private readonly cfg: CircuitBreakerConfig) {}

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

/** Tracks cumulative model spend against a hard monthly ceiling. When the cap
 * is reached the agent stops invoking models (and therefore stops acting). */
export class SpendTracker {
  private spent = 0;

  constructor(private readonly capUsd: number) {}

  add(costUsd: number): void {
    this.spent += costUsd;
  }

  canSpend(): boolean {
    return this.spent < this.capUsd;
  }

  remaining(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  total(): number {
    return this.spent;
  }
}
