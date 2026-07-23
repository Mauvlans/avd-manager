import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

/**
 * Wraps the real Azure Bicep CLI (github.com/Azure/bicep releases) to
 * compile a customer-uploaded .bicep file into ARM JSON, for Settings >
 * Deploy > Bicep's "customer uploads their own template, we ingest it,
 * deploy some details, and provide a deploy link" flow.
 *
 * There is no @azure/bicep npm package (checked: 404 on the real npm
 * registry) — the actual distribution mechanism is a standalone
 * platform-specific binary from Bicep's GitHub releases. Downloaded to
 * tools/bicep in this repo (gitignored — it's a large, OS-specific
 * binary, not something to commit; see tools/README.md for how to fetch
 * it fresh on a new machine) rather than trying to compile Bicep
 * ourselves — that would mean reimplementing a real language compiler,
 * which is exactly the kind of "don't reinvent what Azure already ships"
 * call this product has made elsewhere (native Scaling Plans instead of a
 * custom autoscale engine; avdaccelerator's own Deploy-to-Azure link
 * instead of reimplementing the landing-zone accelerator).
 *
 * Compilation happens by shelling out to the real `bicep build` command
 * against a temp file, since the CLI only operates on real files, not
 * stdin-piped Bicep source with includes/modules resolved correctly.
 */
// Best-effort default: __dirname is apps/api/src/services (ts-node-dev)
// or apps/api/dist/services (compiled) — both sit 4 levels below the repo
// root. This is a guess, not a guarantee (depends on the build/run layout
// staying put) — set BICEP_BINARY_PATH explicitly in any real deployment
// rather than relying on this fallback.
const BICEP_BINARY_PATH = process.env.BICEP_BINARY_PATH || join(__dirname, "..", "..", "..", "..", "tools", "bicep");

export interface BicepCompileResult {
  armJson: string; // the compiled ARM template as a JSON string
}

export class BicepCompileError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

export async function compileBicepToArmJson(bicepSource: string): Promise<BicepCompileResult> {
  const dir = await mkdtemp(join(tmpdir(), "avdm-bicep-"));
  const inputPath = join(dir, `${randomUUID()}.bicep`);
  const outputPath = inputPath.replace(/\.bicep$/, ".json");

  try {
    await writeFile(inputPath, bicepSource, "utf8");

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(BICEP_BINARY_PATH, ["build", inputPath, "--outfile", outputPath]);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(new BicepCompileError(`failed to launch bicep CLI at ${BICEP_BINARY_PATH}: ${err.message}`, ""));
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new BicepCompileError(`bicep build exited with code ${code}`, stderr));
        }
      });
    });

    const armJson = await readFile(outputPath, "utf8");
    return { armJson };
  } finally {
    // Best-effort cleanup — a leftover temp file/dir is not a correctness
    // issue, just tidiness, so failures here are swallowed rather than
    // masking the real compile result/error.
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
