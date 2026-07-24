// The `rigel-pr record` core: label a PR Rigel opened and add it to the ledger.
//
// This exists so an assistant that opens a PR its own way (`gh pr create`, a raw
// git push) still ends up with the SAME provenance as the proposeRepoFix action
// block: the `rigel` labels on GitHub and a row in the Pending PRs card. Doing it
// in one command is the point — three hand-run Bash steps would only be applied
// as reliably as the model remembers them.
//
// Every cluster/network touch is an injected dep so this is unit-testable.
import { parseRepoSlug, addPrRecord, type ChatPrRecord, type GitSource } from "@rigel/k8s";

export interface RecordDeps {
  getToken: () => Promise<string | null>;
  getSources: () => Promise<GitSource[]>;
  getLedger: () => Promise<ChatPrRecord[]>;
  writeLedger: (records: ChatPrRecord[]) => Promise<{ ok: boolean; message?: string }>;
  fetchPr: (
    slug: { owner: string; repo: string },
    number: number,
    token: string,
  ) => Promise<{ title: string; branch: string } | null>;
  applyLabels: (
    slug: { owner: string; repo: string },
    token: string,
    number: number,
    origin: "chat" | "agent",
  ) => Promise<void>;
  now: () => number;
  uuid: () => string;
}

export interface RecordInput {
  prUrl: string;
  /** Deployment slug to sync when the PR merges; inferred from the repo when omitted. */
  source?: string;
  origin?: "chat" | "agent";
}

export interface RecordResult {
  ok: boolean;
  message?: string;
  labelled?: boolean;
  record?: ChatPrRecord;
}

const PR_URL = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

/**
 * Resolve which GitOps deployment a repo's PR should sync. Only unambiguous when
 * the repo has exactly one registered deployment — with several we cannot know
 * which the PR touched, so we record no source rather than guess wrong (the card
 * then shows the PR without a Sync action).
 */
function inferSource(sources: GitSource[], repoSlug: string): { repoName: string; source: string } {
  const match = sources.find((s) => {
    const slug = parseRepoSlug(s.repoURL);
    return slug ? `${slug.owner}/${slug.repo}` === repoSlug : false;
  });
  if (!match) return { repoName: "", source: "" };
  const only = match.deployments.length === 1 ? match.deployments[0]!.name : "";
  return { repoName: match.name, source: only };
}

export async function recordPr(input: RecordInput, deps: RecordDeps): Promise<RecordResult> {
  const m = input.prUrl.match(PR_URL);
  if (!m) return { ok: false, message: `not a GitHub pull request url: ${input.prUrl}` };
  const [, owner, repo, num] = m;
  const slug = { owner: owner!, repo: repo! };
  const repoSlug = `${owner}/${repo}`;
  const number = Number(num);

  const token = await deps.getToken();
  if (!token) return { ok: false, message: "GitHub is not connected — no stored token" };

  const origin = input.origin ?? "chat";
  let labelled = true;
  try {
    await deps.applyLabels(slug, token, number, origin);
  } catch {
    labelled = false; // provenance on GitHub is best-effort; the ledger row still stands
  }

  const details = await deps.fetchPr(slug, number, token);
  const sources = await deps.getSources();
  const inferred = inferSource(sources, repoSlug);

  const record: ChatPrRecord = {
    id: deps.uuid(),
    prUrl: input.prUrl,
    number,
    repoSlug,
    repoName: inferred.repoName,
    source: input.source ?? inferred.source,
    title: details?.title ?? "",
    branch: details?.branch ?? "",
    filePath: "",
    createdAt: new Date(deps.now()).toISOString(),
  };

  const ledger = await deps.getLedger();
  const write = await deps.writeLedger(addPrRecord(ledger, record, { now: deps.now() }));
  if (!write.ok) return { ok: false, message: write.message ?? "could not write the PR ledger", labelled };

  return { ok: true, labelled, record };
}
