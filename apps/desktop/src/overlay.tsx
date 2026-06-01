import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import SubtitleOverlayPage from './pages/SubtitleOverlayPage';
import { bootstrapDesktopRuntimeBridge } from './runtime/desktop-runtime';
import './i18n/config';
import './styles.css';

function OverlayApp() {
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);