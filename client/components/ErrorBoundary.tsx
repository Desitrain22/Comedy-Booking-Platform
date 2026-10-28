import { TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/Button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value clears the error (e.g. pass the pathname so navigating recovers). */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

/** Keeps one crashing page from blanking the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] page crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
          <TriangleAlert className="size-5" aria-hidden />
        </div>
        <p className="font-medium text-fg">Something went wrong on this page.</p>
        <p className="mt-1 text-sm break-words text-fg-muted">{this.state.error.message}</p>
        <Button className="mt-4" variant="secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
