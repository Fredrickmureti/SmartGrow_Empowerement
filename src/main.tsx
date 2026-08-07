import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import App from "./App.tsx";
import "./index.css";

// Preview/dev must never be controlled by a previously published service
// worker: it can keep an old credit-note bundle alive after an RPC migration.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) =>
    Promise.all(registrations.map((registration) => registration.unregister())),
  );
}

// Initialize Sentry before rendering
initSentry();

createRoot(document.getElementById("root")!).render(<App />);
