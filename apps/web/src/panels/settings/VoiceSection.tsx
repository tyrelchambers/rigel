// Voice assistant credentials for the Settings "AI agents" tab. LiveKit room
// credentials plus the OpenRouter key the worker's LLM runs on, and the three
// LiveKit Inference model strings.
//
// Secrets are write-only here: the server reports them as set/unset booleans
// and never sends a stored value back, so a secret input starts empty and an
// untouched one is omitted from the patch rather than resubmitted.
//
// A field an env var supplies wins inside voiceConfig(), so it renders as
// read-only and stays out of the patch. Accepting an edit the server would
// ignore is the one thing this panel must not do — and with the values now
// living in a per-cluster Secret with no local fallback, the same applies when
// no cluster is reachable: the form goes read-only rather than pretending a
// save would land.
import { useId, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faLock, faTriangleExclamation } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";
import {
  useVoiceConfig,
  useSaveVoiceConfig,
  type VoiceConfigView,
  type VoiceField,
} from "@/lib/api";

const TEXT_FIELDS: { key: VoiceField; label: string; placeholder: string }[] = [
  { key: "url", label: "LiveKit URL", placeholder: "wss://your-project.livekit.cloud" },
  { key: "apiKey", label: "LiveKit API key", placeholder: "APIxxxxxxxx" },
  { key: "model", label: "Model", placeholder: "openai/gpt-4.1-mini" },
  { key: "sttModel", label: "Speech to text model", placeholder: "deepgram/nova-3" },
  { key: "ttsModel", label: "Text to speech model", placeholder: "cartesia/sonic-2" },
];

const SECRET_FIELDS: { key: VoiceField; label: string; set: (c: VoiceConfigView) => boolean }[] = [
  { key: "apiSecret", label: "LiveKit API secret", set: (c) => c.apiSecretSet },
  { key: "openrouterApiKey", label: "OpenRouter API key", set: (c) => c.openrouterApiKeySet },
];

type TextEdits = Partial<Record<VoiceField, string>>;
type SecretEdit = { value: string; clear: boolean };
type SecretEdits = Partial<Record<VoiceField, SecretEdit>>;

const INPUT_CLASS =
  "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary disabled:cursor-not-allowed disabled:opacity-60";

function StatusPill({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-2xs text-[var(--fg-tertiary)]">
      <span
        className="size-1.5 rounded-full"
        style={{ background: on ? "var(--status-running)" : "var(--fg-tertiary)" }}
      />
      {label}
    </span>
  );
}

function EnvNote({ envVar }: { envVar: string }) {
  return (
    <span className="flex items-center gap-1 text-2xs text-[var(--fg-tertiary)]">
      <FontAwesomeIcon icon={faLock} className="size-3" />
      Set by <span className="font-mono">{envVar}</span>, which wins over anything saved here.
    </span>
  );
}

/** A write-only credential input. Nests no button inside its label, so the
 *  Clear affordance stays reachable on its own. */
function SecretField({
  label,
  envVar,
  stored,
  edit,
  locked,
  onChange,
  onClear,
}: {
  label: string;
  envVar: string | undefined;
  stored: boolean;
  edit: SecretEdit | undefined;
  locked: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="password"
        className={INPUT_CLASS}
        placeholder={envVar ? "Supplied by the environment" : stored ? "Set. Type to replace." : "Not set"}
        value={edit?.value ?? ""}
        disabled={!!envVar || locked}
        onChange={(e) => onChange(e.target.value)}
      />
      {envVar ? (
        <EnvNote envVar={envVar} />
      ) : edit?.clear ? (
        <span className="text-2xs text-[var(--status-pending)]">Cleared on save.</span>
      ) : (
        stored &&
        !locked && (
          <button
            type="button"
            onClick={onClear}
            className="self-start text-2xs text-destructive transition-opacity hover:opacity-80"
          >
            Clear this key
          </button>
        )
      )}
    </div>
  );
}

export function VoiceSection() {
  const { data: config, error } = useVoiceConfig();
  if (!config) {
    return (
      <p className="text-xs text-muted-foreground">
        {error ? "Voice settings are unavailable on this server." : "Loading voice settings…"}
      </p>
    );
  }
  return <VoiceForm config={config} />;
}

function VoiceForm({ config }: { config: VoiceConfigView }) {
  const save = useSaveVoiceConfig();
  // No cluster reachable is NOT "nothing configured yet": there is nowhere to
  // read from and nowhere to save to, so the form is shown but locked.
  const locked = config.cluster.state === "unavailable";
  const clusterName = config.cluster.context ?? "the current kubeconfig context";
  const [text, setText] = useState<TextEdits>({});
  const [secrets, setSecrets] = useState<SecretEdits>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const envOf = (key: VoiceField) => config.env[key];
  const valueOf = (key: VoiceField) => text[key] ?? (config[key as keyof VoiceConfigView] as string);

  function editText(key: VoiceField, value: string) {
    setText((t) => ({ ...t, [key]: value }));
    setSaved(false);
  }

  function editSecret(key: VoiceField, value: string) {
    setSecrets((s) => ({ ...s, [key]: { value, clear: false } }));
    setSaved(false);
  }

  function clearSecret(key: VoiceField) {
    setSecrets((s) => ({ ...s, [key]: { value: "", clear: true } }));
    setSaved(false);
  }

  // An omitted key means "leave alone" and "" means "clear", the distinction the
  // server draws. Env-supplied fields are omitted so a save cannot overwrite the
  // stored value with the env one the user was only shown.
  function buildPatch(): Partial<Record<VoiceField, string>> {
    const patch: Partial<Record<VoiceField, string>> = {};
    for (const { key } of TEXT_FIELDS) {
      const edited = text[key];
      if (edited === undefined || envOf(key)) continue;
      if (edited === (config[key as keyof VoiceConfigView] as string)) continue;
      patch[key] = edited;
    }
    for (const { key } of SECRET_FIELDS) {
      const edit = secrets[key];
      if (!edit || envOf(key)) continue;
      if (edit.clear) patch[key] = "";
      else if (edit.value) patch[key] = edit.value;
    }
    return patch;
  }

  const patch = buildPatch();
  const dirty = Object.keys(patch).length > 0 && !locked;

  function revert() {
    setText({});
    setSecrets({});
    setSaved(false);
    setSaveError(null);
  }

  async function onSave() {
    setSaveError(null);
    try {
      await save.mutateAsync(patch);
      setText({});
      setSecrets({});
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Voice assistant</h2>
        <div className="flex items-center gap-2">
          <StatusPill on={config.status.enabled} label={config.status.enabled ? "Voice on" : "Voice off"} />
          <StatusPill
            on={config.status.configured}
            label={config.status.configured ? "Configured" : "Not configured"}
          />
        </div>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Talk to Rigel over a LiveKit room. Speech, the model, and speech synthesis all run through
        LiveKit Inference on the same API key and secret; the OpenRouter key runs the assistant
        itself.
        {!config.status.enabled && " Voice stays hidden until RIGEL_VOICE=1 is set."}
      </p>

      {locked ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 size-3.5 text-destructive" />
          <span>
            These settings live in the <span className="font-mono">{config.cluster.secret}</span>{" "}
            Secret on <span className="font-medium">{clusterName}</span>, which could not be reached,
            so nothing can be read or saved here. Connect a cluster and reopen this page.
            {config.cluster.message && (
              <span className="mt-1 block font-mono text-2xs text-muted-foreground">
                {config.cluster.message}
              </span>
            )}
          </span>
        </div>
      ) : (
        <p className="text-xs leading-snug text-muted-foreground">
          Saved in the <span className="font-mono">{config.cluster.secret}</span> Secret in the{" "}
          <span className="font-mono">{config.cluster.namespace}</span> namespace on{" "}
          <span className="font-medium">{clusterName}</span>. Each cluster keeps its own, and
          nothing is written to this machine.
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        {TEXT_FIELDS.map(({ key, label, placeholder }) => {
          const envVar = envOf(key);
          return (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{label}</span>
              <input
                className={INPUT_CLASS}
                placeholder={placeholder}
                value={valueOf(key)}
                disabled={!!envVar || locked}
                onChange={(e) => editText(key, e.target.value)}
              />
              {envVar && <EnvNote envVar={envVar} />}
            </label>
          );
        })}

        {SECRET_FIELDS.map(({ key, label, set }) => (
          <SecretField
            key={key}
            label={label}
            envVar={envOf(key)}
            stored={set(config)}
            edit={secrets[key]}
            locked={locked}
            onChange={(v) => editSecret(key, v)}
            onClear={() => clearSecret(key)}
          />
        ))}
      </div>

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-[var(--fg-tertiary)]">
          {locked ? "Not editable without a cluster." : "Blank a field, or clear a key, then save."}
        </span>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-[var(--status-running)]">
              <FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <Button size="sm" variant="outline" onClick={revert} disabled={!dirty || save.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
            Save voice settings
          </Button>
        </div>
      </div>
    </div>
  );
}
