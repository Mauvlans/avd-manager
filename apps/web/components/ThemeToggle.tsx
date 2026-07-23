import { useEffect, useState } from "react";

/**
 * Light/dark theme toggle, matching Autopatch Companion's mechanism
 * (verified live at http://10.0.0.5:8443/ — sun/moon button pair in the
 * page header): a "light"/"dark" class toggled on the root element, with
 * the actual palette driven by CSS variables (see styles/globals.css).
 * AVD Manager previously had no toggle and no variable system at all —
 * this component + the CSS port are both new.
 *
 * Persists to localStorage so the choice survives reloads, and respects
 * the OS-level prefers-color-scheme on first visit (no stored
 * preference yet) rather than always defaulting to one theme.
 */
const STORAGE_KEY = "avd-manager-theme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const initial: "light" | "dark" =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function setAndPersist(next: "light" | "dark") {
    setTheme(next);
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  return { theme, setTheme: setAndPersist };
}

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
