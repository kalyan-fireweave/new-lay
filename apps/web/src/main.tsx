import { ready } from "./fireweave/start"; // FireWeave: must stay the first import
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./app.tsx";
import { buildStamp } from "./build-stamp.ts";
import "./otel.ts";
import "./styles.css";

document.documentElement.dataset.build = buildStamp;

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
void ready.then(() => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
