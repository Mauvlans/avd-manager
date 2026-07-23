import "dotenv/config";
import express from "express";
import cors from "cors";
import { onboardingRouter } from "./routes/onboarding";
import { hostPoolsRouter } from "./routes/hostPools";
import { scalingPlansRouter } from "./routes/scalingPlans";
import { applicationGroupsRouter } from "./routes/applicationGroups";
import { workspacesRouter } from "./routes/workspaces";
import { costRouter } from "./routes/cost";
import { auditLogRouter } from "./routes/auditLog";
import { setupRouter } from "./routes/setup";
import { serviceVariablesRouter } from "./routes/serviceVariables";
import { customTemplatesRouter } from "./routes/customTemplates";
import { monitoredResourceGroupsRouter } from "./routes/monitoredResourceGroups";
import { resourcesRouter } from "./routes/resources";
import { costFactsRouter } from "./routes/costFacts";
import { telemetryRouter } from "./routes/telemetry";
import { recommendationsRouter } from "./routes/recommendations";

const app = express();
app.use(cors());
app.use(express.json());

// Minimal request/response logging. Added after a real debugging session
// where a browser-observed 302 redirect (Microsoft's admin-consent
// callback hitting this API) left zero trace in the process's stdout,
// making it impossible to tell "the request never arrived" apart from
// "the request arrived and something inside it failed silently" without
// re-instrumenting on the fly. Cheap enough to leave on permanently in
// dev; a production deployment would want this as structured JSON logs
// shipped somewhere durable instead of console.log, not removed outright.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // eslint-disable-next-line no-console
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/onboarding", onboardingRouter);
app.use("/api/host-pools", hostPoolsRouter);
app.use("/api/scaling-plans", scalingPlansRouter);
app.use("/api/application-groups", applicationGroupsRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/cost", costRouter);
app.use("/api/audit-log", auditLogRouter);
app.use("/api/setup", setupRouter);
app.use("/api/service-variables", serviceVariablesRouter);
app.use("/api/custom-templates", customTemplatesRouter);
app.use("/api/monitored-resource-groups", monitoredResourceGroupsRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/cost-facts", costFactsRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api/recommendations", recommendationsRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`AVD Manager API listening on :${port}`);
});

export default app;
