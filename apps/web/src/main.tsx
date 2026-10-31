import { createRoot } from "react-dom/client";
import { Shell } from "./App";
import "./styles.css";

// No StrictMode: its double-mounted effects would open and tear down a second
// peer session on every room entry in development.
createRoot(document.getElementById("root")!).render(<Shell />);
