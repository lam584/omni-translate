import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import SubtitleOverlayPage from './pages/SubtitleOverlayPage';
import { bootstrapDesktopRuntimeBridge } from './runtime/desktop-runtime';
import './i18n/config';
import './styles/overlay.css';

export function OverlayApp() {
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void bootstrapDesktopRuntimeBridge().then((nextCleanup) => {
      if (disposed) {
        nextCleanup();
        return;
      }

      cleanup = nextCleanup;
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <SubtitleOverlayPage />;
}

export function mountOverlayApp(rootElement: HTMLElement | null = document.getElementById('root')) {
  if (!rootElement) {
    throw new Error('Overlay root element not found.');
  }

  return ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <OverlayApp />
    </React.StrictMode>,
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  mountOverlayApp(rootElement);
}
