import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n/config";
import "./styles/startup.css";

const deferredStylesPromise = import("./styles/deferred.css");

// Load deferred CSS after first paint instead of waiting for idle.
// requestAnimationFrame fires before the next paint, so the import starts
// immediately after the initial render is committed.
if (typeof globalThis.requestAnimationFrame === "function") {
  globalThis.requestAnimationFrame(() => {
    void deferredStylesPromise;
  });
} else {
  globalThis.setTimeout(() => {
    void deferredStylesPromise;
  }, 0);
}

export { deferredStylesPromise };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
