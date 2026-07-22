import { useRouter } from "next/router";
import Link from "next/link";

/**
 * L2 sub-navigation for the Settings area — horizontal tab bar under the
 * page header, GitHub-repo-Settings style, per Adam's ask for "an L2 for
 * Settings." Replaces the earlier approach of nesting Onboarding as an
 * indented sidebar sub-link: that worked for exactly one child, but
 * doesn't scale as more settings pages (platform app registration status,
 * environment config, etc.) get added — a flat sidebar item is now the L1
 * ("Settings"), and every page under it renders this shared tab bar as its
 * L2, so new settings pages just add one entry here instead of touching
 * the global sidebar again.
 */
const SETTINGS_TABS = [
  { href: "/settings", label: "General" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/settings/service-variables", label: "Service Variables" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div>
      <h1>Settings</h1>
      <div className="l2-tabs">
        {SETTINGS_TABS.map((tab) => {
          const active = router.pathname === tab.href;
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
