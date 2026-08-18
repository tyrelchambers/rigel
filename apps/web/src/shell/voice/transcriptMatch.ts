/**
 * Deterministic speech-to-resource resolution: matches transcript text against
 * the live mention candidates so pills (and their context summaries) can be
 * pinned without asking the LLM. STT renders hyphenated names as pauses or as
 * the word "dash", so each candidate matches under exact, squashed (hyphens
 * removed), and spaced (hyphens to spaces) forms; pods additionally match under
 * their hash-stripped base name unless a deployment takes the window exactly.
 * This is what keeps a budget voice model grounded.
 */
import type { MentionCandidate } from "@/panels/chat/mentions";

const MAX_WINDOW = 5;
const MIN_FORM_LEN = 3;
const HASH_SEG = /^[a-z0-9]{4,10}$/;

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\b(dash|hyphen)\b/g, "-")
    .replace(/[^a-z0-9\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every spoken shape of `name`: as written, hyphens dropped, hyphens spoken as pauses. */
function formsOf(name: string): string[] {
  const n = name.toLowerCase();
  return n.includes("-") ? [n, n.replace(/-/g, ""), n.replace(/-/g, " ")] : [n];
}

/**
 * `web-7f9b64c8d-x2x4p` spoken as "web". Only trailing segments that look
 * generated come off, and the digit requirement is what keeps a real segment
 * like `manager` in `cert-manager-7d9f8b6c5-q4nzt` from being eaten.
 */
function podBaseName(name: string): string | null {
  const segs = name.toLowerCase().split("-");
  let dropped = 0;
  while (segs.length > 1 && dropped < 2) {
    const last = segs[segs.length - 1]!;
    if (!HASH_SEG.test(last) || !/\d/.test(last)) break;
    segs.pop();
    dropped++;
  }
  return dropped > 0 ? segs.join("-") : null;
}

interface FormHit {
  candidate: MentionCandidate;
  exact: boolean;
}

function indexForms(candidates: MentionCandidate[]): Map<string, FormHit[]> {
  const index = new Map<string, FormHit[]>();
  const add = (form: string, hit: FormHit) => {
    if (form.length < MIN_FORM_LEN) return;
    const bucket = index.get(form);
    if (bucket) bucket.push(hit);
    else index.set(form, [hit]);
  };
  for (const candidate of candidates) {
    for (const form of formsOf(candidate.name)) add(form, { candidate, exact: true });
    if (candidate.kind !== "pod") continue;
    const base = podBaseName(candidate.name);
    if (base) for (const form of formsOf(base)) add(form, { candidate, exact: false });
  }
  return index;
}

const KIND_RANK: Record<MentionCandidate["kind"], number> = { deployment: 0, pod: 1, node: 2 };

/**
 * All candidates named anywhere in `text`, deduped by id. Within one window an
 * exact name beats a pod base name, so "is web healthy" pins the web deployment
 * rather than every pod it owns; ties across kinds are ranked, not dropped.
 */
export function matchTranscript(text: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const words = normalizeTranscript(text).split(" ").filter(Boolean);
  const index = indexForms(candidates);
  const matched = new Map<string, MentionCandidate>();

  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= MAX_WINDOW && i + len <= words.length; len++) {
      const window = words.slice(i, i + len);
      const hits = new Map<string, FormHit>();
      for (const variant of new Set([window.join(""), window.join("-"), window.join(" ")])) {
        for (const hit of index.get(variant) ?? []) {
          if (!hits.get(hit.candidate.id)?.exact) hits.set(hit.candidate.id, hit);
        }
      }
      if (hits.size === 0) continue;
      const all = [...hits.values()];
      const kept = all.some((h) => h.exact) ? all.filter((h) => h.exact) : all;
      kept.sort((a, b) => KIND_RANK[a.candidate.kind] - KIND_RANK[b.candidate.kind]);
      for (const hit of kept) matched.set(hit.candidate.id, hit.candidate);
    }
  }
  return [...matched.values()];
}
