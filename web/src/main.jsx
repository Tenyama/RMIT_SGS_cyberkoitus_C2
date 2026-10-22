import React from "react";
import { createRoot } from "react-dom/client";
import { TideCloakContextProvider } from "@tidecloak/react";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <TideCloakContextProvider configUrl="/tidecloak.json">
      <App />
    </TideCloakContextProvider>
  </React.StrictMode>,
);
