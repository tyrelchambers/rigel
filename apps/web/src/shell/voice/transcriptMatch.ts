/**
 * Deterministic speech-to-resource resolution: matches transcript text against
 * the live mention candidates so pills (and their context summaries) can be
 * pinned without asking the LLM. STT renders hyphenated names as pauses or as
 * the word "dash", so each candidate matches under exact, squashed (hyphens
 * removed), and spaced (hyphens to spaces) forms; pods additionally match under
 * their hash-stripped base name unless a deployment takes the window exactly.
 * Operators also say only the front of a name ("reddex" for `reddex-deploy`),
 * so leading whole segments match too, ranked below every other form and never
 * across a segment boundary. This is what keeps a budget voice model grounded.
 */
import type { MentionCandidate } from "@/panels/chat/mentions";

const MAX_WINDOW = 5;
const MIN_FORM_LEN = 3;
const HASH_SEG = /^[a-z0-9]{4,10}$/;

/**
 * A spoken prefix shared by more candidates than this named a category, not a
 * resource, so it pins nothing and the model is left to enumerate.
 */
const MAX_PREFIX_HITS = 3;

const TIER_EXACT = 0;
const TIER_POD_BASE = 1;
const TIER_PREFIX = 2;

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
  tier: number;
  /** Segments of the candidate's name the speaker left unsaid. */
  unsaid: number;
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
    for (const form of formsOf(candidate.name)) add(form, { candidate, tier: TIER_EXACT, unsaid: 0 });
    // A pod's leading segments are its owner's name, and its trailing ones are
    // generated, so podBaseName is the only prefix a pod may answer to.
    if (candidate.kind === "pod") {
      const base = podBaseName(candidate.name);
      if (base) for (const form of formsOf(base)) add(form, { candidate, tier: TIER_POD_BASE, unsaid: 0 });
      continue;
    }
    const segs = candidate.name.toLowerCase().split("-");
    for (let cut = 1; cut < segs.length; cut++) {
      const prefix = segs.slice(0, cut).join("-");
      for (const form of formsOf(prefix)) add(form, { candidate, tier: TIER_PREFIX, unsaid: segs.length - cut });
    }
  }
  return index;
}

const KIND_RANK: Record<MentionCandidate["kind"], number> = { deployment: 0, pod: 1, node: 2 };

interface WindowHits {
  start: number;
  end: number;
  tier: number;
  hits: FormHit[];
}

function windowHits(words: string[], index: Map<string, FormHit[]>): WindowHits[] {
  const out: WindowHits[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= MAX_WINDOW && i + len <= words.length; len++) {
      const window = words.slice(i, i + len);
      const best = new Map<string, FormHit>();
      for (const variant of new Set([window.join(""), window.join("-"), window.join(" ")])) {
        for (const hit of index.get(variant) ?? []) {
          const seen = best.get(hit.candidate.id);
          if (!seen || hit.tier < seen.tier || (hit.tier === seen.tier && hit.unsaid < seen.unsaid)) {
            best.set(hit.candidate.id, hit);
          }
        }
      }
      if (best.size === 0) continue;
      const all = [...best.values()];
      const tier = Math.min(...all.map((h) => h.tier));
      const kept = all.filter((h) => h.tier === tier);
      kept.sort(
        (a, b) =>
          a.unsaid - b.unsaid ||
          KIND_RANK[a.candidate.kind] - KIND_RANK[b.candidate.kind] ||
          a.candidate.name.localeCompare(b.candidate.name),
      );
      out.push({ start: i, end: i + len, tier, hits: kept });
    }
  }
  return out;
}

/**
 * All candidates named anywhere in `text`, deduped by id. Within one window an
 * exact name beats a pod base name, which beats a segment prefix, so "is web
 * healthy" pins the web deployment rather than every pod it owns; ties across
 * kinds are ranked, not dropped.
 *
 * A prefix only fires over words no exact or base-name match already claimed,
 * and the longest prefix wins the words it covers, so saying more of a name
 * narrows the answer instead of widening it. An ambiguous prefix returns every
 * candidate it fits, least-padded first: the operator sees the alternatives as
 * pills and the model gets their summaries, which beats an interactive
 * disambiguation prompt on a medium where every question costs a turn.
 */
export function matchTranscript(text: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const words = normalizeTranscript(text).split(" ").filter(Boolean);
  const all = windowHits(words, indexForms(candidates));
  const matched = new Map<string, MentionCandidate>();
  const claimed = new Set<number>();

  const take = (w: WindowHits) => {
    for (let p = w.start; p < w.end; p++) claimed.add(p);
    for (const hit of w.hits) matched.set(hit.candidate.id, hit.candidate);
  };
  const overlaps = (w: WindowHits) => {
    for (let p = w.start; p < w.end; p++) if (claimed.has(p)) return true;
    return false;
  };

  for (const w of all) if (w.tier !== TIER_PREFIX) take(w);
  const prefixes = all.filter((w) => w.tier === TIER_PREFIX).sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const w of prefixes) {
    if (w.hits.length > MAX_PREFIX_HITS || overlaps(w)) continue;
    take(w);
  }
  return [...matched.values()];
}
