import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { config } from "@fortawesome/fontawesome-svg-core";
import { queryClient } from "./lib/queryClient";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";
import { SplashScreen } from "./components/SplashScreen";
import "./index.css";

// FA's CSS is imported via index.css in the `base` layer so Tailwind size-*
// utilities win; stop the library from also injecting it unlayered at runtime.
config.autoAddCss = false;

// One-time rebrand migration: copy legacy `helmsman.*` / `helmsman_*` localStorage
// keys to their `rigel.*` / `rigel_*` names so saved UI state (sidebar collapse,
// onboarding flag, chat width, …) survives the Helmsman → Rigel rename.
function migrateLegacyStorage(): void {
  try {
    const GUARD = "rigel.migratedFromHelmsman";
    if (localStorage.getItem(GUARD) === "1") return;
    for (const key of Object.keys(localStorage)) {
      if (!/^helmsman[._]/.test(key)) continue;
      const next = key.replace(/^helmsman/, "rigel");
      const val = localStorage.getItem(key);
      if (val !== null && localStorage.getItem(next) === null) localStorage.setItem(next, val);
      localStorage.removeItem(key);
    }
    localStorage.setItem(GUARD, "1");
  } catch {
    // private mode / quota — nothing to migrate, just proceed.
  }
}

migrateLegacyStorage();

// Boot splash: plays the comet draw once over the mounted app, then fades out.
function Root() {
  const [booting, setBooting] = useState(true);
  return (
    <>
      <App />
      {booting && <SplashScreen onFinish={() => setBooting(false)} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary surface="root">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Root />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
