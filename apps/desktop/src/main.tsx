import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { installGlobalErrorCapture } from "./runtime/logger";
import "./i18n/config";
import "./styles/startup.css";
import "./styles/deferred.css";

installGlobalErrorCapture();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
