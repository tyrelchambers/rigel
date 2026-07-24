// packages/pr-cli/src/index.ts
// `rigel-pr record --url <prUrl> [--source <deployment>] [--origin chat|agent] [--context <ctx>]`
//
// Stamps Rigel's provenance on a pull request the assistant opened by any means
// (`gh pr create`, a raw push) so it matches what the proposeRepoFix action block
// produces: the `rigel` labels on GitHub, plus a row in the Pending PRs card.
//
// The assistant is allowed to run this from Bash (see claudeBridge's allowlist),
// which is the whole point — labelling and recording happen inside OUR code, so
// they cannot be half-applied by a model that forgets a step.
import { kubectl, runProcessWithStdin } from "@rigel/k8s/src/run";
// repoFix is imported by subpath, not the barrel: it pulls in node:fs/path, and
// the barrel has to stay safe for the browser bundle.
import { labelPullRequest } from "@rigel/k8s/src/repoFix";
import {
  parsePullRequests,
  pullRequestsConfigMapJSON,
  parseGitSources,
  GIT_SOURCES_CONFIGMAP,
  GITHUB_SECRET,
  type ChatPrRecord,
} from "@rigel/k8s";
import { recordPr, type RecordDeps } from "./record";

const STATE_NAMESPACE = process.env.HELMSMAN_NAMESPACE ?? "default";

const USAGE =
  "Usage: rigel-pr record --url <pr-url> [--source <deployment>] [--origin chat|agent] [--context <ctx>]";

export interface ParsedArgs {
  command: "record";
  prUrl: string;
  source?: string;
  origin: "chat" | "agent";
  context: string | null;
}

/** Parse argv (without the node/script head). Throws Error on any invalid input. */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "record") throw new Error(USAGE);
  let prUrl: string | undefined;
  let source: string | undefined;
  let context: string | null = null;
  let origin: "chat" | "agent" = "chat";

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") throw new Error(USAGE);
    if (a !== "--url" && a !== "--source" && a !== "--context" && a !== "--origin") {
      throw new Error(`unknown flag ${a}\n${USAGE}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} requires a value`);
    if (a === "--url") prUrl = value;
    else if (a === "--source") source = value;
    else if (a === "--context") context = value;
    else {
      if (value !== "chat" && value !== "agent") throw new Error(`--origin must be chat or agent`);
      origin = value;
    }
  }
  if (!prUrl) throw new Error(`--url is required\n${USAGE}`);
  return { command: "record", prUrl, source, origin, context };
}

const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "rigel",
  "X-GitHub-Api-Version": "2022-11-28",
});

/** Real cluster + GitHub wiring for the record core. */
export function realDeps(context: string | null): RecordDeps {
  const getJSON = async <T>(args: string[], pick: (o: never) => T, fallback: T): Promise<T> => {
    const res = await kubectl(context, args);
    if (res.code !== 0) return fallback;
    try {
      return pick(JSON.parse(res.stdout) as never);
    } catch {
      return fallback;
    }
  };

  return {
    getToken: () =>
      getJSON<string | null>(
        ["get", "secret", GITHUB_SECRET, "-n", STATE_NAMESPACE, "-o", "json"],
        (o: { data?: Record<string, string> }) =>
          o.data?.token ? Buffer.from(o.data.token, "base64").toString("utf8") : null,
        null,
      ),
    getSources: () =>
      getJSON(
        ["get", "configmap", GIT_SOURCES_CONFIGMAP, "-n", STATE_NAMESPACE, "-o", "json"],
        (o: { data?: Record<string, string> }) => parseGitSources(o.data?.["sources.json"]),
        [],
      ),
    getLedger: () =>
      getJSON(
        ["get", "configmap", "rigel-pull-requests", "-n", STATE_NAMESPACE, "-o", "json"],
        (o: { data?: Record<string, string> }) => parsePullRequests(o.data?.["pull-requests.json"]),
        [] as ChatPrRecord[],
      ),
    writeLedger: async (records) => {
      const manifest = pullRequestsConfigMapJSON(STATE_NAMESPACE, records);
      const args = context ? ["--context", context] : [];
      const res = await runProcessWithStdin("kubectl", [...args, "apply", "-f", "-"], manifest);
      return res.code === 0
        ? { ok: true }
        : { ok: false, message: res.stderr || res.stdout || `kubectl exited ${res.code}` };
    },
    fetchPr: async (slug, number, token) => {
      const res = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls/${number}`, {
        headers: githubHeaders(token),
      });
      if (!res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { title?: string; head?: { ref?: string } };
      return { title: j.title ?? "", branch: j.head?.ref ?? "" };
    },
    applyLabels: labelPullRequest,
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }

  const res = await recordPr(
    { prUrl: args.prUrl, source: args.source, origin: args.origin },
    realDeps(args.context),
  );
  process.stdout.write(JSON.stringify(res) + "\n");
  if (!res.ok) {
    process.stderr.write(`rigel-pr: ${res.message ?? "failed"}\n`);
    process.exit(1);
  }
}

// Only run when executed as the CLI (not when imported by tests).
if (process.argv[1] && /rigel-pr|pr-cli/.test(process.argv[1])) {
  void main();
}
