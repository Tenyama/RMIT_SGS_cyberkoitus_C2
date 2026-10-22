import React from "react";
import { createRoot } from "react-dom/client";
import { TideCloakContextProvider } from "@tidecloak/react";
import App from "./App.jsx";
import { DEV } from "./lib/api.js";
import "./style.css";

// Dev mode (VITE_DEV_ROLES set) skips Tide login entirely, so no /tidecloak.json is needed.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {DEV ? (
      <App />
    ) : (
      <TideCloakContextProvider configUrl="/tidecloak.json">
        <App />
      </TideCloakContextProvider>
    )}
  </React.StrictMode>,
);
