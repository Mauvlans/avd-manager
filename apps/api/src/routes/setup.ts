import { Router } from "express";
import { PlatformSetupService } from "../services/platformSetupService";
import { setPlatformAppRegistration, getPlatformConfig, resetPlatformAppRegistration } from "../services/platformConfigStore";

const setupService = new PlatformSetupService();

/**
 * Platform bootstrap routes. Not tenant-scoped (no x-tenant-id) — this is a
 * one-time-per-environment operation an admin runs to create AVD Manager's
 * own multi-tenant Entra app registration, mirroring the "Run setup
 * wizard…" pattern in /mnt/ai-work/W365Import (device-code sign-in with a
 * well-known Microsoft client, since a brand-new app has no credentials of
 * its own yet). The admin's access/refresh tokens are held only in the
 * browser session (frontend keeps the device-code poll result and passes
 * the access token straight through to /complete) — never persisted
 * server-side.
 */
export const setupRouter = Router();

setupRouter.post("/device-code", async (_req, res) => {
  try {
    const session = await setupService.startDeviceCode();
    res.json(session);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

setupRouter.post("/device-code/poll", async (req, res) => {
  const { deviceCode } = req.body ?? {};
  if (!deviceCode) return res.status(400).json({ error: "deviceCode is required" });
  try {
    const outcome = await setupService.pollDeviceCode(deviceCode);
    res.json(outcome);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Completes setup once the admin's device-code sign-in produced an access
 * token client-side. Creates the app registration and immediately activates
 * it as this API instance's platform config (in-memory — see
 * platformConfigStore.ts) so the onboarding wizard's consent links use the
 * real client id right away, with no manual env var copy/paste or restart.
 * Response still includes the client id/secret for the admin to persist
 * into real env vars for next restart, since the in-memory store does not
 * survive a process restart (documented gap). */
setupRouter.post("/complete", async (req, res) => {
  const { accessToken, displayName } = req.body ?? {};
  if (!accessToken || !displayName) {
    return res.status(400).json({ error: "accessToken and displayName are required" });
  }
  try {
    const redirectUri = getPlatformConfig().graphConsentRedirectUri;
    const result = await setupService.createPlatformAppRegistration(accessToken, displayName, redirectUri);
    setPlatformAppRegistration(result.appId, result.clientSecret);
    res.json({ ...result, activated: true, redirectUriRegistered: redirectUri });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Resets the platform config back to the placeholder, so Setup's step 0
 * shows up again in the onboarding wizard (e.g. if the previously-created
 * app registration turns out to be broken/misconfigured and needs
 * recreating, as happened once already — see resetPlatformAppRegistration's
 * own docstring). Deliberately not tenant-scoped and has no side effects
 * beyond this in-memory config — does NOT delete the actual Entra app
 * registration itself, just stops this API instance from using it. */
setupRouter.post("/reset", (_req, res) => {
  resetPlatformAppRegistration();
  res.json({ status: "reset" });
});
