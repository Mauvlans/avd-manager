jest.mock("../db/pool", () => ({
  withSystem: jest.fn(),
  withTenant: jest.fn(),
}));
jest.mock("../services/armHostPoolClient", () => {
  const actual = jest.requireActual("../services/armHostPoolClient");
  return { ...actual, ArmHostPoolClient: jest.fn() };
});

import { withSystem } from "../db/pool";
import { runScalingActionRetryWorker } from "../jobs/scalingActionRetryWorker";
import { ArmHostPoolClient } from "../services/armHostPoolClient";

const MockedArmHostPoolClient = ArmHostPoolClient as jest.MockedClass<typeof ArmHostPoolClient>;

describe("runScalingActionRetryWorker", () => {
  const mockWithSystem = withSystem as jest.Mock;
  let queryMock: jest.Mock;
  let auditInserts: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    auditInserts = [];
    queryMock = jest.fn();
    mockWithSystem.mockImplementation(async (fn: any) =>
      fn({
        query: (...args: any[]) => {
          auditInserts.push(args);
          return queryMock(...args);
        },
      })
    );
  });

  function mockCandidateRow(overrides: Partial<any> = {}) {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          audit_log_id: "audit-1",
          tenant_id: "tenant-1",
          policy_id: "policy-1",
          subscription_id: "sub-1",
          resource_group: "rg-1",
          host_pool_name: "pool-1",
          entra_tenant_id: "entra-1",
          after_state: JSON.stringify({
            actions: [{ hostName: "host1", action: "start_host", reason: "scale out" }],
            failures: ["host1: failed — OSProvisioningTimedOut"],
          }),
          ...overrides,
        },
      ],
    });
  }

  it("retries a failed start_host action and records retried_success when the retry succeeds", async () => {
    mockCandidateRow();
    const listSessionHosts = jest.fn().mockResolvedValue([
      { name: "host1", resourceId: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/host1-vm" },
    ]);
    const startVm = jest.fn().mockResolvedValue({ outcome: "succeeded" });
    MockedArmHostPoolClient.mockImplementation(
      () => ({ listSessionHosts, startVm } as unknown as ArmHostPoolClient)
    );

    await runScalingActionRetryWorker();

    expect(startVm).toHaveBeenCalledWith("sub-1", "rg-1", "host1-vm");
    const auditCall = auditInserts.find((args) => args[0].includes("INSERT INTO audit_log"));
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toContain("retried_success");
  });

  it("records retried_still_failed when the retry ARM call also fails", async () => {
    mockCandidateRow();
    const listSessionHosts = jest.fn().mockResolvedValue([
      { name: "host1", resourceId: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/host1-vm" },
    ]);
    const startVm = jest.fn().mockResolvedValue({ outcome: "failed", reason: "still broken" });
    MockedArmHostPoolClient.mockImplementation(
      () => ({ listSessionHosts, startVm } as unknown as ArmHostPoolClient)
    );

    await runScalingActionRetryWorker();

    expect(startVm).toHaveBeenCalledTimes(1); // bounded: exactly one retry attempt, no loop
    const auditCall = auditInserts.find((args) => args[0].includes("INSERT INTO audit_log"));
    expect(auditCall![1]).toContain("retried_still_failed");
  });

  it("retries a failed deallocate_host action via deleteSessionHost", async () => {
    mockCandidateRow({
      after_state: JSON.stringify({
        actions: [{ hostName: "host2", action: "deallocate_host", reason: "scale in" }],
        failures: ["host2: failed — ResourceBusy"],
      }),
    });
    const deleteSessionHost = jest.fn().mockResolvedValue({ outcome: "succeeded" });
    MockedArmHostPoolClient.mockImplementation(
      () => ({ deleteSessionHost } as unknown as ArmHostPoolClient)
    );

    await runScalingActionRetryWorker();

    expect(deleteSessionHost).toHaveBeenCalledWith("sub-1", "rg-1", "pool-1", "host2");
    const auditCall = auditInserts.find((args) => args[0].includes("INSERT INTO audit_log"));
    expect(auditCall![1]).toContain("retried_success");
  });

  it("does nothing when there are no partially-failed candidates", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await runScalingActionRetryWorker();
    expect(MockedArmHostPoolClient).not.toHaveBeenCalled();
  });

  it("does not throw the whole worker when a retry throws unexpectedly, and still records an audit entry", async () => {
    mockCandidateRow();
    const listSessionHosts = jest.fn().mockRejectedValue(new Error("network blip"));
    MockedArmHostPoolClient.mockImplementation(
      () => ({ listSessionHosts } as unknown as ArmHostPoolClient)
    );

    await expect(runScalingActionRetryWorker()).resolves.toBeUndefined();
    const auditCall = auditInserts.find((args) => args[0].includes("INSERT INTO audit_log"));
    expect(auditCall![1]).toContain("retried_still_failed");
  });
});
