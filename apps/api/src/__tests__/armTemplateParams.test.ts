import { parseArmTemplateParameters } from "../services/armTemplateParams";

describe("parseArmTemplateParameters", () => {
  it("extracts type, description, defaultValue, allowedValues, and required correctly", () => {
    const armJson = JSON.stringify({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      parameters: {
        vmSize: {
          type: "string",
          defaultValue: "Standard_D2s_v3",
          allowedValues: ["Standard_D2s_v3", "Standard_D4s_v3"],
          metadata: { description: "The VM size for session hosts" },
        },
        hostCount: {
          type: "int",
          metadata: { description: "Number of session hosts to deploy" },
        },
        enableMonitoring: {
          type: "bool",
          defaultValue: false,
        },
      },
    });

    const result = parseArmTemplateParameters(armJson);
    expect(result).toHaveLength(3);

    const vmSize = result.find((p) => p.name === "vmSize")!;
    expect(vmSize.type).toBe("string");
    expect(vmSize.description).toBe("The VM size for session hosts");
    expect(vmSize.defaultValue).toBe("Standard_D2s_v3");
    expect(vmSize.allowedValues).toEqual(["Standard_D2s_v3", "Standard_D4s_v3"]);
    expect(vmSize.required).toBe(false);

    const hostCount = result.find((p) => p.name === "hostCount")!;
    expect(hostCount.type).toBe("int");
    expect(hostCount.required).toBe(true); // no defaultValue present

    const enableMonitoring = result.find((p) => p.name === "enableMonitoring")!;
    expect(enableMonitoring.defaultValue).toBe(false);
    expect(enableMonitoring.required).toBe(false); // has a defaultValue, even though it's falsy
  });

  it("returns an empty array for a template with no parameters block", () => {
    const armJson = JSON.stringify({ $schema: "...", resources: [] });
    expect(parseArmTemplateParameters(armJson)).toEqual([]);
  });

  it("throws a clear error for invalid JSON instead of an opaque parse exception", () => {
    expect(() => parseArmTemplateParameters("{not valid json")).toThrow(/not valid JSON/);
  });
});
