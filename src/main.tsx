import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// /c/<id> is a customer's chart; everything else is the chart maker. Each loads only its own code.
const App = lazy(() => import("./App"));
const Tracker = lazy(() => import("./Tracker"));
const link = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{20,64})\/?$/);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      {link ? <Tracker id={link[1]} /> : <App />}
    </Suspense>
  </StrictMode>,
);
