import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { currentLocale } from "./lib/i18n";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("CCP-Bot could not find the application root element.");
}

// `index.html` ships `lang="en"` because that was the only language it had. Screen readers and the
// browser's spelling and hyphenation rules follow this attribute, so it has to agree with the
// dictionary the page is actually rendered from.
document.documentElement.lang = currentLocale();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
