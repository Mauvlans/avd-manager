import { useRouter } from "next/router";
import Link from "next/link";

/**
 * L2 sub-navigation for the Deploy area (Template / Custom / Bicep),
 * mirroring components/SettingsLayout.tsx's horizontal-tab pattern. Only
 * "Template" is fully built for v1 (per Adam's mock + explicit scope:
 * templates the admin fills a few details into and we publish the rest).
 * "Custom" and "Bicep" are placeholder tabs so the L2 shape matches the
 * mock now, without pretending those flows exist yet.
 */
const DEPLOY_TABS = [
  { href: "/deploy", label: "Template" },
  { href: "/deploy/custom", label: "Custom" },
  { href: "/deploy/bicep", label: "Bicep" },
];

export default function DeployLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div>
      <h1>Deploy</h1>
      <div className="l2-tabs">
        {DEPLOY_TABS.map((tab) => {
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
