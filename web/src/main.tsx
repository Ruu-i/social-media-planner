import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { Landing } from "./components/Landing.tsx";
import "./index.css";

/**
 * Two pages, no router.
 *
 * CloudFront already serves index.html for every path, so a path check is the
 * whole routing requirement. Pulling in react-router to choose between two
 * screens would add a dependency and a bundle for a single `if`.
 */
const isApp = window.location.pathname.startsWith("/app");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isApp ? <App /> : <Landing />}</StrictMode>,
);
