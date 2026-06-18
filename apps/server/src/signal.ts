// Signal bridge proxy — server side of docs/parity/settings.md §1.3, §2.2, §7.1.
//
// POST /api/signal dispatches on `action`:
//   link     → port-forward svc/signal-cli-rest, GET /v1/qrcodelink, return PNG.
//   accounts → port-forward, GET /v1/accounts, return { accounts: string[] }.
//   sendTest → port-forward, POST /v2/send, tear down. Returns { ok: true }.
//   status   → { ready } once a tunnel can be opened (used by the UI to confirm).
//
// Each action opens a SHORT-LIVED port-forward to the bridge Service, makes one
// HTTP request to 127.0.0.1:<localPort>, then tears the tunnel down. No state is
// kept between calls (the QR-poll loop re-opens a tunnel per poll — cheap and
// avoids leaking processes if the client navigates away). Everything runs via
// kubectl argv (no shell). Port-forward stderr is surfaced verbatim so the UI
// can show "Port-forward failed: <stderr>".

import { buildKubectlArgs } from "@helmsman/k8s/src/run";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  SIGNAL_BRIDGE_NAME,
  SIGNAL_BRIDGE_PORT,
  SIGNAL_DEVICE_NAME,
} from "@helmsman/k8s/src/signal";

/** Local port the tunnel binds (avoids the 8080 collision the spec calls out). */
const LOCAL_PORT = 18099;

export type SignalAction = "link" | "accounts" | "status" | "sendTest";

export interface SignalRequest {
  action: SignalAction;
  namespace?: string;
  number?: string;
  recipients?: string[];
  message?: string;
}

/** A served `POST /api/signal` outcome. PNG actions return raw bytes + type. */
export type SignalResult =
  | { kind: "png"; bytes: Uint8Array }
  | { kind: "json"; body: unknown }
  | { kind: "error"; status: number; message: string };

class PortForwardError extends Error {}

/**
 * Open a port-forward to `svc/signal-cli-rest` in `namespace`, run `fn` against
 * the local tunnel, then always tear the tunnel down. Resolves when kubectl
 * prints its "Forwarding from …" ready line; rejects with the stderr if the
 * process exits first (Service missing, RBAC, etc).
 */
async function withPortForward<T>(
  context: string | null,
  namespace: string,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const args = buildKubectlArgs(context, [
    "port-forward",
    `svc/${SIGNAL_BRIDGE_NAME}`,
    `${LOCAL_PORT}:${SIGNAL_BRIDGE_PORT}`,
    "-n",
    namespace,
  ]);

  let proc: ChildProcess;
  try {
    proc = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PortForwardError(`kubectl not found: ${message}`);
  }

  try {
    await waitForForwardReady(proc);
    return await fn(`http://127.0.0.1:${LOCAL_PORT}`);
  } finally {
    proc.kill();
    // Drain so the child fully exits (avoids zombie/EPIPE on the next forward).
    try {
      if (proc.exitCode === null && proc.signalCode === null) await once(proc, "close");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Resolve once kubectl prints its "Forwarding from 127.0.0.1:<port>" line.
 * Rejects with a PortForwardError carrying the captured stderr if the process
 * exits before becoming ready, or after a 10s ceiling.
 */
async function waitForForwardReady(proc: ChildProcess): Promise<void> {
  const stderrChunks: string[] = [];

  // Capture stderr in the background for the error message.
  proc.stderr?.on("data", (buf: Buffer) => stderrChunks.push(buf.toString("utf8")));

  const ready = new Promise<void>((resolve, reject) => {
    if (!proc.stdout) {
      reject(new PortForwardError("port-forward produced no output"));
      return;
    }
    let stdoutBuf = "";
    proc.stdout.on("data", (buf: Buffer) => {
      stdoutBuf += buf.toString("utf8");
      if (stdoutBuf.includes("Forwarding from")) resolve();
    });
    proc.stdout.on("end", () => {
      reject(new PortForwardError(stderrChunks.join("").trim() || "port-forward exited"));
    });
  });

  const exitedFirst = once(proc, "close").then(() => {
    throw new PortForwardError(stderrChunks.join("").trim() || "port-forward exited early");
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new PortForwardError("port-forward timed out")), 10_000),
  );

  await Promise.race([ready, exitedFirst, timeout]);
}

// ---------------------------------------------------------------------------
// Bridge HTTP calls (run inside withPortForward)
// ---------------------------------------------------------------------------

/** Numbers registered/linked on the bridge (the device's own number once linked). */
async function fetchAccounts(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/v1/accounts`);
  if (!res.ok) throw new Error(`bridge accounts ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Route a parsed Signal request. Never throws — failures are returned as an
 * { kind: "error" } so the route handler can pick the HTTP status and the UI
 * can render the verbatim message. The port-forward stderr is surfaced as
 * "Port-forward failed: <stderr>" per the spec.
 */
export async function handleSignal(
  context: string | null,
  req: SignalRequest,
): Promise<SignalResult> {
  const namespace = (req.namespace ?? "default").trim() || "default";
  try {
    switch (req.action) {
      case "link":
        return await withPortForward(context, namespace, async (baseUrl) => {
          const res = await fetch(
            `${baseUrl}/v1/qrcodelink?device_name=${encodeURIComponent(SIGNAL_DEVICE_NAME)}`,
          );
          if (!res.ok) {
            return {
              kind: "error" as const,
              status: 500,
              message: `Could not load QR code: bridge returned ${res.status}`,
            };
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          return { kind: "png" as const, bytes };
        });

      case "accounts":
        return await withPortForward(context, namespace, async (baseUrl) => {
          const accounts = await fetchAccounts(baseUrl);
          return { kind: "json" as const, body: { accounts } };
        });

      case "status":
        return await withPortForward(context, namespace, async () => ({
          kind: "json" as const,
          body: { ready: true },
        }));

      case "sendTest": {
        const number = (req.number ?? "").trim();
        const recipients = req.recipients ?? [];
        if (number === "") {
          return {
            kind: "error",
            status: 422,
            message: "No linked sender number — link your phone first.",
          };
        }
        if (recipients.length === 0) {
          return {
            kind: "error",
            status: 422,
            message: "Add at least one recipient (then Save) before sending a test.",
          };
        }
        return await withPortForward(context, namespace, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/v2/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message:
                req.message ?? "✅ Helmsman test notification — Signal is wired up.",
              number,
              recipients,
            }),
          });
          if (!res.ok) {
            const detail = (await res.text().catch(() => "")).trim() || `HTTP ${res.status}`;
            return { kind: "error" as const, status: 500, message: `Test send failed: ${detail}` };
          }
          return { kind: "json" as const, body: { ok: true } };
        });
      }

      default:
        return { kind: "error", status: 422, message: `unknown action: ${String(req.action)}` };
    }
  } catch (err) {
    if (err instanceof PortForwardError) {
      return { kind: "error", status: 500, message: `Port-forward failed: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 500, message: `Could not reach bridge: ${message}` };
  }
}
