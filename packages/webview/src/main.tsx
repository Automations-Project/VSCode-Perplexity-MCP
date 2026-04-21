import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { installWebviewConsoleForwarder } from "./lib/vscode.js";
import "./styles.css";

installWebviewConsoleForwarder();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
