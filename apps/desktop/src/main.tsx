import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { DesktopApiProvider } from "./runtime/desktop-api-context";
import { installGlobalErrorCapture } from "./runtime/logger";
import { installContextMenuGuard } from "./runtime/context-menu-guard";
import "./i18n/config";
import "./styles/startup.css";
import "./styles/deferred.css";

installGlobalErrorCapture();
installContextMenuGuard();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <DesktopApiProvider>
        <App />
      </DesktopApiProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
