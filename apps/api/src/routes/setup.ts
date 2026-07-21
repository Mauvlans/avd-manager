import { Router } from "express";
import { PlatformSetupService } from "../services/platformSetupService";

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
 * token client-side. Returns the created app's client ID + secret — the
 * caller (setup wizard UI) is responsible for prompting the admin to save
 * these into the environment (ENTRA_APP_CLIENT_ID / ENTRA_APP_CLIENT_SECRET)
 * since this API process does not persist or hot-reload its own env. */
setupRouter.post("/complete", async (req, res) => {
  const { accessToken, displayName } = req.body ?? {};
  if (!accessToken || !displayName) {
    return res.status(400).json({ error: "accessToken and displayName are required" });
  }
  try {
    const result = await setupService.createPlatformAppRegistration(accessToken, displayName);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
