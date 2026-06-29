/**
 * Last-resort crash handler for the server process. An unhandled throw in a
 * stream "data" callback or a send to a half-closed socket would otherwise take
 * the whole server down with Node's default behavior, leaking the kubectl
 * watch/port-forward/PTY children it spawned. We instead log the error, run a
 * best-effort cleanup, and exit non-zero so the desktop supervisor restarts us
 * cleanly (the web client reconnects on its own).
 *
 * Pure factory so the exit/cleanup wiring is unit-testable without killing the
 * test process.
 */
export function makeFatalHandler(
  stopAll: () => Promise<unknown>,
  exit: (code: number) => void,
  log: (...args: unknown[]) => void,
  backstopMs = 2_000,
): (err: unknown) => void {
  return (err) => {
    log("[rigel] fatal error — shutting down for a clean restart:", err);
    let exited = false;
    const go = (): void => {
      if (exited) return;
      exited = true;
      exit(1);
    };
    // Run cleanup, then exit whether it resolved or rejected.
    Promise.resolve()
      .then(stopAll)
      .catch(() => {})
      .finally(go);
    // Backstop: never hang on a wedged cleanup.
    const t = setTimeout(go, backstopMs) as { unref?: () => void };
    t.unref?.();
  };
}
