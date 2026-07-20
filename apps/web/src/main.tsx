import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../../packages/tokens/dist/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
