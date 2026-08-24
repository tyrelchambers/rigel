interface ResourceRefLinkProps {
  resource: { name: string; namespace?: string; uid?: string } | null;
  onGoTo: () => void;
  className?: string;
}

export function ResourceRefLink({ resource, onGoTo, className = "" }: ResourceRefLinkProps) {
  if (!resource) {
    return <span className={`font-mono text-[var(--fg-tertiary)] ${className}`}>—</span>;
  }

  if (!resource.uid) {
    return (
      <span className={`truncate font-mono text-[var(--fg-secondary)] ${className}`} title={resource.name}>
        {resource.name}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onGoTo}
      className={`truncate font-mono text-[var(--accent-primary)] hover:underline ${className}`}
      title={resource.name}
    >
      {resource.name}
    </button>
  );
}
