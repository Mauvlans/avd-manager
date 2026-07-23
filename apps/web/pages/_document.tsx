import Document, { Html, Head, Main, NextScript, DocumentProps } from "next/document";

/**
 * Sets the .dark class on <html> synchronously before first paint, based
 * on localStorage (or OS prefers-color-scheme if unset) — avoids a
 * flash-of-wrong-theme on load, which would otherwise happen since
 * ThemeToggle's useEffect only runs client-side after React mounts.
 * Standard pattern (same one next-themes uses under the hood), applied
 * here directly since this app doesn't use next-themes as a dependency.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("avd-manager-theme");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    if (theme === "dark") document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;

export default class MyDocument extends Document<DocumentProps> {
  render() {
    return (
      <Html>
        <Head />
        <body>
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
