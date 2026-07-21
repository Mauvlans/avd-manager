import { useEffect, useState } from "react";

const KEY = "avdm.tenantId";

/** Trivial client-side "current tenant" context for this MVP: after
 * onboarding, the tenant id is stashed in localStorage and reused for all
 * subsequent tenant-scoped API calls. This stands in for real signed-in
 * session state (see PROGRESS.md — no real end-user auth yet). */
export function useTenantId(): [string, (id: string) => void] {
  const [tenantId, setTenantIdState] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem(KEY);
    if (stored) setTenantIdState(stored);
  }, []);

  const setTenantId = (id: string) => {
    window.localStorage.setItem(KEY, id);
    setTenantIdState(id);
  };

  return [tenantId, setTenantId];
}
