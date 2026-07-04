// packages/audit-cli/src/kubectl.ts
// Injectable kubectl execution so the audits are unit-testable without a
// cluster. `KubectlRunner` is the seam: gather.ts and audits dispatch take one
// as a parameter instead of shelling out directly, so tests pass a stub that
// returns fixture JSON.
//
// The real runner delegates to @rigel/k8s's `kubectl()` (packages/k8s/src/run.ts),
// which already implements the context-insertion rule mirrored from
// apps/server/src/watchManager.ts:160-167 — a null/absent context stays OUT of
// the argv so kubectl falls back to its own current-context, never `--context
// null` or similar. Reusing it here (rather than re-implementing) keeps ONE
// context-handling implementation shared by the watch manager, the server, and
// this CLI.
import { kubectl } from "@rigel/k8s/src/run";

/** A runner that executes `kubectl <args>` and resolves to stdout, or rejects
 *  on failure. Real implementation shells out; tests supply a stub. */
export type KubectlRunner = (args: string[]) => Promise<string>;

/** Build a KubectlRunner bound to a context ( null = kubectl's own current-context). */
export function realKubectlRunner(context: string | null): KubectlRunner {
  return async (args: string[]) => {
    const res = await kubectl(context, args);
    if (res.code !== 0) {
      throw new Error(`kubectl ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
    return res.stdout;
  };
}
