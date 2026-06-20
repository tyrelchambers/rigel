import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { queryClient } from "./lib/queryClient";
import App from "./App";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
