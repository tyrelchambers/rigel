import { Switch } from "@/components/ui/switch";
import { useSetSshHosts, useSshHosts } from "@/lib/api";

export function SshHostsSection() {
  const { data: hosts = [] } = useSshHosts();
  const set = useSetSshHosts();
  const enabledCount = hosts.filter((h) => h.enabled).length;

  const toggle = (alias: string, on: boolean) =>
    set.mutate(hosts.filter((h) => (h.alias === alias ? on : h.enabled)).map((h) => h.alias));

  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs text-[var(--fg-secondary)]">
        Hosts from your ~/.ssh/config that the chat may run commands on. Reads run on their own;
        anything that changes a host asks you first.
      </p>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center pb-1.5">
          <h2 className="font-mono text-3xs font-semibold tracking-wider text-[var(--fg-tertiary)] uppercase">
            SSH hosts
          </h2>
          <div className="flex-1" />
          <span className="text-2xs text-[var(--fg-tertiary)]">
            {enabledCount} of {hosts.length} enabled
          </span>
        </div>
        {hosts.length === 0 ? (
          <div className="flex flex-col gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4">
            <span className="text-xs text-[var(--fg-secondary)]">
              No hosts found in ~/.ssh/config.
            </span>
            <span className="text-2xs text-[var(--fg-tertiary)]">
              Add a Host entry to your SSH config and it shows up here.
            </span>
          </div>
        ) : (
          hosts.map((h) => (
            <div
              key={h.alias}
              className="flex items-center gap-2 border-b border-[var(--border-subtle)] py-2.5"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold text-[var(--fg-primary)]">{h.alias}</span>
                <span className="font-mono text-3xs text-[var(--fg-tertiary)]">
                  {h.user}@{h.hostName}:{h.port}
                </span>
              </div>
              <div className="flex-1" />
              <Switch
                aria-label={`Allow chat on ${h.alias}`}
                checked={h.enabled}
                disabled={set.isPending}
                onCheckedChange={(on) => toggle(h.alias, on)}
              />
            </div>
          ))
        )}
      </div>
      {set.error && <p className="text-xs text-destructive">{set.error.message}</p>}
    </section>
  );
}
