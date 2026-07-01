// ReportsTab — scheduled cluster digests. Reproduces the Pencil design
// (clankerlocal.pen: "Assistant — Reports tab" + "Assistant — Digest editor
// (modal)"). The editor uses the app's standard <Modal> shell (never an ad-hoc
// dialog); the body uses the app's var(--…) design tokens and premade
// Button/Switch. Data wiring dispatches through the assistant `run` action.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Plus,
  Send,
  Eye,
  SquarePen,
  Trash2,
  CalendarClock,
  MessageCircle,
  Hash,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import {
  digestScheduleSummary,
  type DigestSubscription,
  type DigestChannel,
  type DigestInput,
  type DigestLookback,
} from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Modal } from "@/components/ui/modal";
import { useSettings } from "@/panels/settings/useSettings";
import { useAssistantCtx } from "../AssistantContext";
import { relativeTime } from "../display";

// ---------------------------------------------------------------------------
// Styling + static tables
// ---------------------------------------------------------------------------

const FIELD =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5 text-[13px] text-[var(--fg-primary)] outline-none transition-colors placeholder:text-[var(--fg-tertiary)] focus:border-[var(--accent-primary)]";

const CHANNEL_META: Record<DigestChannel, { label: string; Icon: LucideIcon }> = {
  signal: { label: "Signal", Icon: MessageCircle },
  matrix: { label: "Matrix", Icon: Hash },
  webhook: { label: "Webhook", Icon: Webhook },
};

const DAYS: { idx: number; letter: string; name: string }[] = [
  { idx: 0, letter: "S", name: "Sunday" },
  { idx: 1, letter: "M", name: "Monday" },
  { idx: 2, letter: "T", name: "Tuesday" },
  { idx: 3, letter: "W", name: "Wednesday" },
  { idx: 4, letter: "T", name: "Thursday" },
  { idx: 5, letter: "F", name: "Friday" },
  { idx: 6, letter: "S", name: "Saturday" },
];

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

type Cadence = "daily" | "weekly" | "custom";

/** Infer the cadence segment from a day set (7 = daily, 1 = weekly, else custom). */
function cadenceOf(days: number[]): Cadence {
  if (days.length >= 7) return "daily";
  if (days.length === 1) return "weekly";
  return "custom";
}

function lastSentLabel(iso?: string): string {
  return iso ? `sent ${relativeTime(iso)} ago` : "never sent";
}

/** Mono field caption sitting above an input (Pencil: 11px, tertiary, tracked). */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11px] tracking-[0.5px] text-[var(--fg-tertiary)]">
      {children}
    </span>
  );
}

/** A segmented (pill) control: a bordered track with equal, selectable segments. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex w-full gap-[3px] rounded-md border border-[var(--border-subtle)] bg-white/[0.04] p-[3px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-sm py-1.5 text-[13px] transition-colors ${
              active
                ? "border border-[var(--border-subtle)] bg-white/[0.08] font-semibold text-[var(--fg-primary)]"
                : "text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportsTab() {
  const { d, ns, working, run } = useAssistantCtx();
  const settings = useSettings(false);

  const localTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  // `Intl.supportedValuesOf` is an ES2022 runtime API (present in Chromium/Electron
  // and Node 18+) not yet in this project's TS lib target — assert its shape.
  const zones = useMemo<string[]>(
    () =>
      (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
        "timeZone",
      ),
    [],
  );

  // Connected channels — offer a channel only when it is actually usable.
  const connected = useMemo<DigestChannel[]>(() => {
    const list: DigestChannel[] = [];
    if (settings.status === "linked") list.push("signal");
    if (settings.matrixStatus === "connected") list.push("matrix");
    if (d.webhookURL.trim() !== "") list.push("webhook");
    return list;
  }, [settings.status, settings.matrixStatus, d.webhookURL]);

  // --- Editor Modal state ---
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [channel, setChannel] = useState<DigestChannel | "">("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [days, setDays] = useState<number[]>(ALL_DAYS);
  const [time, setTime] = useState("07:00");
  const [timezone, setTimezone] = useState(localTz);
  const [lookbackMode, setLookbackMode] = useState<"sinceLast" | "fixed">("sinceLast");
  const [lookbackHours, setLookbackHours] = useState(24);
  const [enabled, setEnabled] = useState(true);

  // --- "generating…" affordance for Preview/Send now ---
  const [awaiting, setAwaiting] = useState<{
    id: string;
    mode: "send" | "preview";
    baseline: string | undefined;
  } | null>(null);

  useEffect(() => {
    if (!awaiting) return;
    const current =
      awaiting.mode === "preview"
        ? d.digestState?.lastPreview?.at
        : d.digestState?.lastSentAt[awaiting.id];
    if (current && current !== awaiting.baseline) setAwaiting(null);
  }, [d.digestState, awaiting]);

  const zoneOptions = useMemo(
    () => (zones.includes(timezone) ? zones : [timezone, ...zones]),
    [zones, timezone],
  );

  const channelOptions = useMemo<DigestChannel[]>(() => {
    if (channel && !connected.includes(channel)) return [channel, ...connected];
    return connected;
  }, [channel, connected]);

  function openCreate() {
    setEditingId(null);
    setLabel("");
    setChannel(connected[0] ?? "");
    setCadence("daily");
    setDays(ALL_DAYS);
    setTime("07:00");
    setTimezone(localTz);
    setLookbackMode("sinceLast");
    setLookbackHours(24);
    setEnabled(true);
    setOpen(true);
  }

  function openEdit(sub: DigestSubscription) {
    setEditingId(sub.id);
    setLabel(sub.label);
    setChannel(sub.channel);
    setDays(sub.days);
    setCadence(cadenceOf(sub.days));
    setTime(sub.time);
    setTimezone(sub.timezone);
    setLookbackMode(sub.lookback.mode);
    setLookbackHours(sub.lookback.mode === "fixed" ? sub.lookback.hours : 24);
    setEnabled(sub.enabled);
    setOpen(true);
  }

  function pickCadence(next: Cadence) {
    setCadence(next);
    if (next === "daily") setDays(ALL_DAYS);
    else if (next === "weekly") setDays([days[0] ?? 1]);
    // custom keeps the current selection
  }

  function toggleDay(idx: number) {
    if (cadence === "weekly") {
      setDays([idx]);
      return;
    }
    const next = days.includes(idx)
      ? days.filter((day) => day !== idx)
      : [...days, idx].sort((a, b) => a - b);
    if (next.length === 0) return; // always keep at least one day
    setDays(next);
    setCadence(cadenceOf(next));
  }

  const valid =
    label.trim() !== "" &&
    channel !== "" &&
    days.length > 0 &&
    /^\d{1,2}:\d{2}$/.test(time) &&
    (lookbackMode !== "fixed" || lookbackHours >= 1);

  function save() {
    if (channel === "") return;
    const lookback: DigestLookback =
      lookbackMode === "fixed"
        ? { mode: "fixed", hours: Math.max(1, Math.floor(lookbackHours) || 1) }
        : { mode: "sinceLast" };
    const digest: DigestInput = {
      label: label.trim(),
      channel,
      days: [...days].sort((a, b) => a - b),
      time,
      timezone,
      lookback,
      enabled,
    };
    if (editingId) {
      run({ action: "saveDigest", namespace: ns, digestId: editingId, digest }, () => setOpen(false));
    } else {
      run({ action: "saveDigest", namespace: ns, digest }, () => setOpen(false));
    }
  }

  function fireSendNow(id: string, mode: "send" | "preview") {
    setAwaiting({
      id,
      mode,
      baseline: mode === "preview" ? d.digestState?.lastPreview?.at : d.digestState?.lastSentAt[id],
    });
    run({ action: "sendDigestNow", namespace: ns, digestId: id, digestMode: mode });
  }

  // Row "preview" opens the editor for that digest and generates its preview,
  // so the result shows in the modal's Preview block (per the design).
  function rowPreview(sub: DigestSubscription) {
    openEdit(sub);
    fireSendNow(sub.id, "preview");
  }

  const activeCount = d.digests.filter((s) => s.enabled).length;
  const pausedCount = d.digests.length - activeCount;

  const editPreview =
    editingId && d.digestState?.lastPreview?.id === editingId ? d.digestState.lastPreview : undefined;
  const awaitingPreview = awaiting?.mode === "preview" && awaiting.id === editingId;

  return (
    <div className="space-y-3.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--fg-primary)]">Scheduled reports</p>
          <p className="text-xs text-[var(--fg-tertiary)]">
            Wake up to a synopsis of how your cluster did overnight, sent to a channel you pick.
            Reports still arrive while the agent is paused.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={openCreate}>
          <Plus />
          New digest
        </Button>
      </div>

      {/* Digests list */}
      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3.5 py-3">
          <p className="text-sm font-semibold text-[var(--fg-primary)]">Your digests</p>
          {d.digests.length > 0 && (
            <span className="font-mono text-xs text-[var(--fg-tertiary)]">
              {activeCount} active · {pausedCount} paused
            </span>
          )}
        </div>

        {d.digests.length === 0 ? (
          <p className="px-3.5 py-6 text-sm text-[var(--fg-tertiary)]">
            No scheduled digests yet. Create one to get a morning synopsis.
          </p>
        ) : (
          d.digests.map((sub, i) => {
            const { label: chLabel, Icon } = CHANNEL_META[sub.channel];
            const lastSent = lastSentLabel(d.digestState?.lastSentAt[sub.id]);
            return (
              <div
                key={sub.id}
                className={`flex items-center justify-between gap-3 px-3.5 py-3 ${
                  i > 0 ? "border-t border-[var(--border-subtle)]" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Icon
                    className={`size-[17px] shrink-0 ${
                      sub.enabled ? "text-[var(--accent-primary)]" : "text-[var(--fg-tertiary)]"
                    }`}
                  />
                  <div className="min-w-0">
                    <p
                      className={`truncate text-sm font-medium ${
                        sub.enabled ? "text-[var(--fg-primary)]" : "text-[var(--fg-tertiary)]"
                      }`}
                    >
                      {sub.label}
                    </p>
                    <p className="truncate font-mono text-xs text-[var(--fg-tertiary)]">
                      {digestScheduleSummary(sub)} · {chLabel} · {lastSent}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3.5">
                  <Switch
                    checked={sub.enabled}
                    disabled={working}
                    aria-label={`${sub.enabled ? "Pause" : "Enable"} ${sub.label}`}
                    onCheckedChange={() =>
                      run({
                        action: "toggleDigest",
                        namespace: ns,
                        digestId: sub.id,
                        digestEnabled: !sub.enabled,
                      })
                    }
                  />
                  <div className="h-[18px] w-px bg-[var(--border-subtle)]" />
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={working}
                      aria-label={`Send now: ${sub.label}`}
                      title="Send now"
                      onClick={() => fireSendNow(sub.id, "send")}
                    >
                      <Send />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={working}
                      aria-label={`Preview: ${sub.label}`}
                      title="Preview"
                      onClick={() => rowPreview(sub)}
                    >
                      <Eye />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={working}
                      aria-label={`Edit: ${sub.label}`}
                      title="Edit"
                      onClick={() => openEdit(sub)}
                    >
                      <SquarePen />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={working}
                      aria-label={`Delete: ${sub.label}`}
                      title="Delete"
                      onClick={() =>
                        run({ action: "deleteDigest", namespace: ns, digestId: sub.id })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create / edit modal — the app's standard Modal shell */}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={editingId ? "Edit digest" : "New scheduled digest"}
        icon={<CalendarClock className="size-[18px] text-[var(--accent-primary)]" />}
        iconBackground={false}
        maxWidth="!max-w-xl"
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-[1.5] text-[var(--fg-tertiary)]">
            A short synopsis of overnight incidents, fixes, and current health, delivered on your
            schedule.
          </p>

          {/* Label */}
          <div className="flex flex-col gap-1.5">
            <Caption>Label</Caption>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Morning cluster digest"
              className={FIELD}
            />
          </div>

          {/* Deliver to */}
          <div className="flex flex-col gap-1.5">
            <Caption>Deliver to</Caption>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as DigestChannel)}
              className={FIELD}
              disabled={channelOptions.length === 0}
            >
              {channelOptions.length === 0 ? (
                <option value="">No connected channels</option>
              ) : (
                <>
                  {channel === "" && <option value="">Select a channel</option>}
                  {channelOptions.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_META[c].label}
                    </option>
                  ))}
                </>
              )}
            </select>
            <span className="text-[11.5px] text-[var(--fg-tertiary)]">
              {channelOptions.length === 0
                ? "Connect Signal, Matrix, or a webhook in Settings first."
                : "Only your connected channels appear here."}
            </span>
          </div>

          {/* Schedule */}
          <div className="flex flex-col gap-2">
            <Caption>Schedule</Caption>
            <Segmented<Cadence>
              value={cadence}
              onChange={pickCadence}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "custom", label: "Custom" },
              ]}
            />
            <div className="flex gap-1.5">
              {DAYS.map((day) => {
                const on = days.includes(day.idx);
                return (
                  <button
                    key={day.idx}
                    type="button"
                    aria-pressed={on}
                    aria-label={day.name}
                    onClick={() => toggleDay(day.idx)}
                    className={`h-8 flex-1 rounded-sm border text-[12.5px] font-semibold transition-colors ${
                      on
                        ? "border-[var(--accent-primary)] bg-[var(--accent-dim)] text-[var(--accent-primary)]"
                        : "border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
                    }`}
                  >
                    {day.letter}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Caption>Send time</Caption>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={`${FIELD} font-mono`}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Caption>Timezone</Caption>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={FIELD}
                >
                  {zoneOptions.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* What it covers */}
          <div className="flex flex-col gap-2">
            <Caption>What it covers</Caption>
            <Segmented<"sinceLast" | "fixed">
              value={lookbackMode}
              onChange={setLookbackMode}
              options={[
                { value: "sinceLast", label: "Since the last digest" },
                { value: "fixed", label: "Fixed window" },
              ]}
            />
            {lookbackMode === "fixed" && (
              <div className="flex items-center gap-2 pt-0.5">
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={lookbackHours}
                  onChange={(e) => setLookbackHours(Math.max(1, Number(e.target.value) || 1))}
                  className={`${FIELD} w-24 font-mono`}
                />
                <span className="text-xs text-[var(--fg-tertiary)]">hours</span>
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Caption>Preview</Caption>
              <Button
                type="button"
                variant="muted"
                size="sm"
                disabled={!editingId || working}
                onClick={() => editingId && fireSendNow(editingId, "preview")}
              >
                <Eye />
                Generate preview
              </Button>
            </div>
            <div className="rounded-md border border-[var(--border-subtle)] bg-black/25 p-3">
              {!editingId ? (
                <p className="text-xs text-[var(--fg-tertiary)]">
                  Save the digest first, then generate a preview.
                </p>
              ) : awaitingPreview ? (
                <p className="text-xs text-[var(--fg-tertiary)]">
                  Generating… the agent renders this within ~30s.
                </p>
              ) : editPreview ? (
                <pre className="max-h-56 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--fg-secondary)] select-text">
                  {editPreview.text}
                </pre>
              ) : (
                <p className="text-xs text-[var(--fg-tertiary)]">
                  Generate a preview to see the digest text.
                </p>
              )}
            </div>
          </div>

          {/* Footer: Enabled on the left, actions on the right */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2.5">
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
              <span className="text-[13px] text-[var(--fg-secondary)]">Enabled</span>
            </div>
            <div className="flex items-center gap-2.5">
              <Button variant="muted" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={working || !valid}>
                Save digest
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
