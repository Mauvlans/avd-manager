import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

/**
 * Local-disk storage for customer-uploaded custom templates (Settings >
 * Deploy > Bicep). Per Adam's explicit choice ("store it locally") rather
 * than Postgres or in-memory — a plain directory of compiled ARM JSON
 * files, served back out over HTTP by a static route in server.ts so
 * Azure's portal (which needs to fetch the template from a public HTTPS
 * URL, not receive an uploaded blob directly) can read it.
 *
 * Storage root is configurable via CUSTOM_TEMPLATES_DIR so a real
 * deployment can point this at a persistent volume; defaults to a
 * directory alongside the API's own source, mirroring how
 * platform-app-registrations.log is stored (gitignored, local to this
 * install).
 */
const STORAGE_DIR = process.env.CUSTOM_TEMPLATES_DIR || join(__dirname, "..", "..", "custom-templates");

export interface StoredTemplate {
  id: string;
  tenantId: string;
  fileName: string;
  armJson: string;
  uploadedAt: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
}

function pathFor(id: string): string {
  return join(STORAGE_DIR, `${id}.json`);
}

/** Stores a compiled ARM template's JSON on disk and returns its
 * generated id (used to build the public-facing serve URL and the
 * Deploy-to-Azure link). The tenantId + original fileName are embedded in
 * the stored envelope (not just the bare ARM JSON) so the static-serve
 * route can enforce that a template is only ever re-served for API calls
 * originating from ITS OWN tenant context — see routes/customTemplates.ts. */
export async function storeCustomTemplate(tenantId: string, fileName: string, armJson: string): Promise<StoredTemplate> {
  await ensureDir();
  const id = randomUUID();
  const record: StoredTemplate = { id, tenantId, fileName, armJson, uploadedAt: new Date().toISOString() };
  await writeFile(pathFor(id), JSON.stringify(record), "utf8");
  return record;
}

export async function getCustomTemplate(id: string): Promise<StoredTemplate | null> {
  try {
    const raw = await readFile(pathFor(id), "utf8");
    return JSON.parse(raw) as StoredTemplate;
  } catch {
    return null;
  }
}
