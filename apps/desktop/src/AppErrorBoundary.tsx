import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from './i18n/config';
import { createLogger } from './runtime/logger';

const logger = createLogger('runtime');

type AppErrorBoundaryProps = { children: ReactNode };
type AppErrorBoundaryState = { hasError: boolean; message: string | null };

/**
 * Top-level React error boundary: render-phase crashes previously unmounted
 * the tree with no diagnostics trace at all. The boundary records the error
 * (and component stack) through the unified logger so it reaches app.log,
 * then shows a minimal recovery screen.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error(
      'react.render_crash captured by the top-level error boundary',
      `error=${error.name}: ${error.message} componentStack=${(info.componentStack ?? '-').trim().split('\n')[0] ?? '-'}`,
    );
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          height: '100vh',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '18px' }}>
          {i18n.t('runtime.errorBoundary.title', { defaultValue: '界面发生错误，已记录到诊断日志' })}
        </h1>
        <p style={{ opacity: 0.8, maxWidth: '480px', wordBreak: 'break-all' }}>
          {this.state.message}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          {i18n.t('runtime.errorBoundary.reload', { defaultValue: '重新加载' })}
        </button>
      </div>
    );
  }
}
