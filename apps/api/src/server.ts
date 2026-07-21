import "dotenv/config";
import express from "express";
import cors from "cors";
import { onboardingRouter } from "./routes/onboarding";
import { hostPoolsRouter } from "./routes/hostPools";
import { scalingPoliciesRouter, costRouter } from "./routes/scalingPolicies";
import { auditLogRouter } from "./routes/auditLog";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/onboarding", onboardingRouter);
app.use("/api/host-pools", hostPoolsRouter);
app.use("/api/scaling-policies", scalingPoliciesRouter);
app.use("/api/cost", costRouter);
app.use("/api/audit-log", auditLogRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`AVD Manager API listening on :${port}`);
});

export default app;
