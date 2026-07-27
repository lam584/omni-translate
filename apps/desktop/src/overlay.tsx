import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import SubtitleOverlayPage from './pages/SubtitleOverlayPage';
import { DesktopApiProvider } from './runtime/desktop-api-context';
import { bootstrapDesktopRuntimeBridge } from './runtime/desktop-runtime';
import './i18n/config';
import './styles/overlay.css';

export function OverlayApp() {
  const { t } = useTranslation();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void bootstrapDesktopRuntimeBridge()
      .then((nextCleanup) => {
        if (disposed) {
          nextCleanup();
          return;
        }

        cleanup = nextCleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setBootstrapError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [bootstrapAttempt]);

  if (bootstrapError) {
    return (
      <main className="overlay-bootstrap-fallback" role="alert">
        <strong>{t('overlay.bootstrapFailed')}</strong>
        <span>{t('overlay.bootstrapFailedHint')}</span>
        <button type="button" onClick={() => { setBootstrapError(null); setBootstrapAttempt((attempt) => attempt + 1); }}>
          {t('common.retry')}
        </button>
      </main>
    );
  }

  return <SubtitleOverlayPage />;
}

export function mountOverlayApp(rootElement: HTMLElement | null = document.getElementById('root')) {
  if (!rootElement) {
    throw new Error('Overlay root element not found.');
  }

  return ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <DesktopApiProvider>
        <OverlayApp />
      </DesktopApiProvider>
    </React.StrictMode>,
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  mountOverlayApp(rootElement);
}
