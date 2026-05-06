import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }
  componentDidCatch(error: Error, info: any) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    this.setState({ componentStack: info?.componentStack ?? null });
  }
  copyDetails = () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    const text = `${error.name}: ${error.message}\n\n${componentStack ?? error.stack ?? ''}`;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  render() {
    if (this.state.hasError) {
      const { error, componentStack } = this.state;
      const message = error ? `${error.name}: ${error.message}` : 'Unknown error';
      const stack = componentStack ?? error?.stack ?? '';
      return (
        <div className="min-h-screen flex items-center justify-center bg-dark-900 p-8">
          <div className="text-center max-w-2xl w-full">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-red-500/10 flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <h2 className="text-xl font-bold text-theme-heading mb-2">Something went wrong</h2>
            <p className="text-theme-muted mb-6">An unexpected error occurred. Please try reloading the page.</p>
            <button
              onClick={() => window.location.reload()}
              className="btn-primary px-6 py-2.5"
            >
              Reload Page
            </button>
            {error && (
              <details
                open={import.meta.env.DEV}
                className="mt-6 text-left bg-dark-800/60 border border-dark-400/30 rounded-xl p-4"
              >
                <summary className="cursor-pointer text-sm text-theme-muted select-none">
                  Show error details
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-red-300 font-mono">
                  {message}
                </pre>
                {stack && (
                  <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-theme-faint font-mono max-h-64 overflow-auto">
                    {stack}
                  </pre>
                )}
                <button
                  onClick={this.copyDetails}
                  className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-dark-400/40 text-theme-muted hover:text-theme-primary hover:bg-dark-700 transition-colors"
                >
                  Copy details
                </button>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
