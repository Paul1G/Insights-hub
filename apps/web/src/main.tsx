// iX core CSS MUST be the first import — iX web components register their
// styles at module-evaluation time; loading them after a component renders
// causes a flash of unstyled custom elements on first paint.
import "@siemens/ix/dist/siemens-ix/siemens-ix.css";

// Brand-theme overlay (binding). Loaded right after the iX core CSS so brand
// tokens override iX defaults under data-ix-theme="brand".
import "@siemens-ix/corporate-theme/dist/css/corporate-theme-hybrid.css";

// Side-effect import: registers the brand `<ix-siemens-logo>` custom element
// rendered by AppHeaderBrand.tsx in the application header's logo slot. The
// corporate-theme CSS alone does NOT define the element — without this import
// the logo silently renders nothing.
import "@siemens-ix/corporate-theme/dist/components/siemens-logo.js";

import { getIxTheme } from "@siemens/ix-aggrid";
import { IxApplicationContext } from "@siemens/ix-react";
import { AllCommunityModule, ModuleRegistry, provideGlobalGridOptions } from "ag-grid-community";
import * as agGrid from "ag-grid-community";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import App from "./App.tsx";
import "./i18n";
import "./index.css";
import { routes } from "./routes";
ModuleRegistry.registerModules([AllCommunityModule]);

async function configureAgGridTheme() {
  const ixTheme = getIxTheme(agGrid);
  provideGlobalGridOptions({
    theme: ixTheme,
  });
}

// Offline support for the built app (see public/sw.js). Not registered in dev,
// where Vite's module graph must always come from the dev server.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}

configureAgGridTheme().then(() => {
  const router = createHashRouter([{ path: "/", element: <App />, children: routes }]);

  const rootEl = document.getElementById("root");
  if (rootEl === null) {
    throw new Error("Missing #root mount point in index.html");
  }

  createRoot(rootEl).render(
    <StrictMode>
      <IxApplicationContext>
        <RouterProvider router={router} />
      </IxApplicationContext>
    </StrictMode>,
  );
});
