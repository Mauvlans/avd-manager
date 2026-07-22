import "dotenv/config";
import express from "express";
import cors from "cors";
import { onboardingRouter } from "./routes/onboarding";
import { hostPoolsRouter } from "./routes/hostPools";
import { scalingPoliciesRouter, costRouter } from "./routes/scalingPolicies";
import { auditLogRouter } from "./routes/auditLog";
import { setupRouter } from "./routes/setup";

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
app.use("/api/scaling-policies", scalingPoliciesRouter);
app.use("/api/cost", costRouter);
app.use("/api/audit-log", auditLogRouter);
app.use("/api/setup", setupRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`AVD Manager API listening on :${port}`);
});

export default app;
