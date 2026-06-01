import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import WelcomeLanguagePicker from './components/welcome/WelcomeLanguagePicker';
import { getCurrentLanguage, hasCompletedWelcome } from './i18n/config';
import { bootstrapDesktopRuntimeBridge } from './runtime/desktop-runtime';
import { router } from './router';

function App() {
  const [welcomeVisible, setWelcomeVisible] = useState<boolean>(() => !hasCompletedWelcome());

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

  return (
    <>
      <RouterProvider router={router} />
      {welcomeVisible ? (
        <WelcomeLanguagePicker
          initialLanguage={getCurrentLanguage()}
          onDone={() => setWelcomeVisible(false)}
        />
      ) : null}
    </>
  );
}

export default App;
