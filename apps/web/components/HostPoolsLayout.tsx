import { useRouter } from "next/router";
import Link from "next/link";

/**
 * L2 sub-navigation for the Host Pools area (Host Pools / Application
 * Groups / Workspaces), per Adam's mock — mirrors components/
 * DeployLayout.tsx and components/SettingsLayout.tsx's horizontal-tab
 * pattern exactly, so this codebase has one L2-tab-bar convention, not
 * three slightly different ones.
 */
const HOST_POOLS_TABS = [
  { href: "/host-pools", label: "Host Pools" },
  { href: "/host-pools/application-groups", label: "Application Groups" },
  { href: "/host-pools/workspaces", label: "Workspaces" },
];

export default function HostPoolsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div>
      <h1>Host Pools</h1>
      <div className="l2-tabs">
        {HOST_POOLS_TABS.map((tab) => {
          // Host pool detail pages (/host-pools/[id]) should still
          // highlight the "Host Pools" tab, not go unhighlighted.
          const active =
            tab.href === "/host-pools"
              ? router.pathname === "/host-pools" || router.pathname === "/host-pools/[id]"
              : router.pathname === tab.href;
          return (
            <Link key={tab.href} href={tab.href} className={active ? "l2-tab active" : "l2-tab"}>
              {tab.label}
            </Link>
          );
        })}
      </div>
      <div className="l2-content">{children}</div>
    </div>
  );
}
