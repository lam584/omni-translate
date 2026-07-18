import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';

import './i18n/config';
import { bootstrapDesktopRuntimeBridge } from './runtime/desktop-runtime';
import { getCurrentWindow } from './runtime/overlay-window-adapter';
import { useAppStore } from './stores/app-store';
import './styles/overlay-unlock.css';

export function OverlayUnlockApp() {
  const { t } = useTranslation();
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void bootstrapDesktopRuntimeBridge().then((nextCleanup) => {
      if (disposed) nextCleanup();
      else cleanup = nextCleanup;
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const unlock = () => {
    updateSubtitleDraft({ overlayLocked: false });
    void getCurrentWindow().hide();
  };

  return (
    <button className="overlay-unlock-button" onClick={unlock} type="button">
      {t('overlay.unlockAction', { defaultValue: '解锁' })}
    </button>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <OverlayUnlockApp />
    </React.StrictMode>,
  );
}
