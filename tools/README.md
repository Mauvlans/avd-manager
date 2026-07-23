# tools/

## bicep

The real Azure Bicep CLI binary, used by `apps/api/src/services/bicepCompiler.ts`
to compile customer-uploaded `.bicep` files into ARM JSON for Settings > Deploy >
Bicep's "upload your own template, we ingest it, deploy it" flow.

**Not committed to git** — it's a large (~100MB), OS/architecture-specific binary.
Fetch it fresh on any machine that needs to run the API's Bicep upload feature:

```bash
curl -sL "https://github.com/Azure/bicep/releases/latest/download/bicep-linux-x64" -o tools/bicep
chmod +x tools/bicep
tools/bicep --version   # sanity check
```

For other platforms, swap `bicep-linux-x64` for the matching release asset name
(see https://github.com/Azure/bicep/releases) — e.g. `bicep-osx-x64`,
`bicep-win-x64.exe`.

If `tools/bicep` isn't present at runtime, override the path via the
`BICEP_BINARY_PATH` environment variable to point at wherever it's installed
instead (e.g. a system-wide `bicep` on PATH).
