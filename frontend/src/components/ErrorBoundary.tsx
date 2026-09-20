// A render crash in one page must never blank the whole console: the nav has to survive so the
// evaluator can move on. Resets automatically when the route changes.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { IconAlert } from './Icons';

interface Props { children: ReactNode; resetKey?: string }
interface State { error: Error | null; stack: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, stack: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? null });
    // Keep the real trace in the console for whoever is debugging.
    console.error('[aletheia] page crashed:', error, info.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-state" role="alert">
        <IconAlert size={18} />
        <div className="grow">
          <div className="title">This page failed to render</div>
          <div className="detail">{error.message}</div>
          <div className="fix">
            Usually a response that did not match the contract in <code>docs/CONTRACTS.md</code>.
            The rest of the console still works — pick another page in the sidebar.
          </div>
          <div className="btn-row">
            <button type="button" onClick={() => this.setState({ error: null, stack: null })}>
              Try again
            </button>
          </div>
          {stack && (
            <details className="disclosure">
              <summary>Component stack</summary>
              <pre className="out">{stack.trim()}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
