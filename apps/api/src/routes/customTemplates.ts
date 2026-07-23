import { Router } from "express";
import multer from "multer";
import { tenantAuth } from "../middleware/tenantAuth";
import { compileBicepToArmJson, BicepCompileError } from "../services/bicepCompiler";
import { parseArmTemplateParameters } from "../services/armTemplateParams";
import { storeCustomTemplate, getCustomTemplate } from "../services/customTemplateStore";
import { getPlatformConfig } from "../services/platformConfigStore";
import { writeAuditLog } from "../lib/auditLog";
import { withTenant } from "../db/pool";

/**
 * Settings > Deploy > Bicep — customer uploads their own .bicep or ARM
 * .json template, we compile/parse it, store the compiled result, and
 * hand back a Deploy-to-Azure link + the parameter schema for a small
 * generated form (mirrors Deploy > Template's "admin fills a few details,
 * we publish the rest" UX, but for an arbitrary customer-supplied
 * template instead of one of our three built-in presets).
 *
 * The upload/compile/parse routes are tenant-scoped (tenantAuth) since
 * this is customer-owned content; the raw-template serve route
 * (GET /raw/:id) is DELIBERATELY UNAUTHENTICATED — Azure's portal itself
 * is the caller when it resolves the Deploy-to-Azure link's uri=, and it
 * has no way to send our x-tenant-id/x-api-key headers. This mirrors
 * exactly how the RBAC delegation template is served today (a public,
 * unauthenticated raw.githubusercontent.com URL) — the template JSON
 * itself contains no secrets (parameters are filled in by whoever runs
 * the deployment, in their own subscription, under their own portal
 * session), so public-readability of the compiled template is an
 * acceptable, deliberate trade-off, not an oversight.
 */
export const customTemplatesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

customTemplatesRouter.post("/upload", tenantAuth, upload.single("file"), async (req, res) => {
  const tenantId = (req as any).tenantId as string;
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    return res.status(400).json({ error: "no file uploaded (expected multipart field 'file')" });
  }

  const source = file.buffer.toString("utf8");
  const isBicep = file.originalname.toLowerCase().endsWith(".bicep");

  let armJson: string;
  try {
    if (isBicep) {
      const result = await compileBicepToArmJson(source);
      armJson = result.armJson;
    } else {
      // Assume it's already ARM JSON — validate it parses before storing.
      JSON.parse(source);
      armJson = source;
    }
  } catch (err) {
    if (err instanceof BicepCompileError) {
      return res.status(400).json({ error: `bicep compile failed: ${err.message}`, detail: err.stderr });
    }
    return res.status(400).json({ error: `invalid template: ${(err as Error).message}` });
  }

  let parameters;
  try {
    parameters = parseArmTemplateParameters(armJson);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  const stored = await storeCustomTemplate(tenantId, file.originalname, armJson);

  await withTenant(tenantId, async (client) => {
    await writeAuditLog(client, {
      tenantId,
      actor: req.header("x-actor") || "unknown",
      action: "custom_template_uploaded",
      resourceType: "custom_templates",
      resourceId: stored.id,
      beforeState: null,
      afterState: { fileName: file.originalname, parameterCount: parameters.length },
    });
  });

  const publicBase = getPlatformConfig().publicApiBaseUrl;
  const rawUrl = `${publicBase}/api/custom-templates/raw/${stored.id}`;
  const deployUrl = `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(rawUrl)}`;

  res.json({
    id: stored.id,
    fileName: stored.fileName,
    parameters,
    rawUrl,
    deployUrl,
  });
});

/** Deliberately unauthenticated — see header comment. Azure's portal is
 * the real caller here, not our own frontend. */
customTemplatesRouter.get("/raw/:id", async (req, res) => {
  const stored = await getCustomTemplate(req.params.id);
  if (!stored) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "application/json");
  res.send(stored.armJson);
});
