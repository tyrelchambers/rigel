import { Component, type ErrorInfo, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faRotateRight } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { Button } from "@/components/ui/button";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Label for the surface that failed, shown in the fallback copy. */
  surface?: string;
  /** Replaces the default full-screen fallback. `reset` re-mounts the subtree. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[rigel] render error in ${this.props.surface ?? "app"}`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--surface-sunken)] p-8">
        <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-6">
          <div className="flex items-center gap-2.5">
            <FontAwesomeIcon icon={faTriangleExclamation} className="size-4 text-destructive" />
            <h1 className="text-sm font-semibold text-[var(--fg-primary)]">Rigel hit an unexpected error</h1>
          </div>
          <p className="text-xs text-[var(--fg-secondary)]">
            The interface stopped rendering. Reloading usually clears it. If it keeps happening, the details below
            are what to report.
          </p>
          <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 font-mono text-xs whitespace-pre-wrap text-[var(--fg-tertiary)]">
            {error.stack ?? `${error.name}: ${error.message}`}
          </pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={this.reset}>
              Try again
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              <FontAwesomeIcon icon={faRotateRight} />
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
