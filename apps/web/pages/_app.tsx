import type { AppProps } from "next/app";
import Link from "next/link";
import { useRouter } from "next/router";
import "../styles/globals.css";

/**
 * L1 (top-level) navigation, restructured from a single horizontal top-nav
 * into a persistent left sidebar + "Overview" as the default/home surface,
 * per Adam's explicit ask: "introduce a L1 menu and an Overview page for
 * managing your environment." The prior top-nav (Onboarding/Host Pools/
 * Cost/Audit Log) becomes sidebar items, with Overview added as the new
 * landing page (see pages/index.tsx) and Scaling Plans added to the menu
 * (it existed as a page already but was never linked from global nav).
 */
const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/host-pools", label: "Host Pools" },
  { href: "/scaling-plans", label: "Scaling Plans" },
  { href: "/cost", label: "Cost" },
  { href: "/audit-log", label: "Audit Log" },
];

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">AVD Manager</div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            // Host pool detail pages (/host-pools/[id]) should still
            // highlight the "Host Pools" L1 item, not go unhighlighted —
            // match on path prefix rather than exact equality for any
            // item other than the exact-match-only root "/".
            const active =
              item.href === "/" ? router.pathname === "/" : router.pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={active ? "sidebar-link active" : "sidebar-link"}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="app-main">
        <Component {...pageProps} />
      </main>
    </div>
  );
}
