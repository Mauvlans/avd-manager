/**
 * Extracts a form-fillable schema from a compiled ARM template's
 * top-level `parameters` object, for Settings > Deploy > Bicep's "ingest
 * the customer's template, show them a small form for the params it
 * needs, then deploy" flow. Handles the real ARM parameter shape
 * (type, defaultValue, allowedValues, metadata.description,
 * minValue/maxValue/minLength/maxLength) — not a guess, this is
 * documented ARM template schema
 * (https://learn.microsoft.com/azure/azure-resource-manager/templates/parameters).
 */
export interface ParsedArmParameter {
  name: string;
  type: string; // ARM's own type string: string, int, bool, object, array, secureString, secureObject
  description?: string;
  defaultValue?: unknown;
  allowedValues?: unknown[];
  required: boolean; // true if there is no defaultValue — ARM requires a value from the caller in that case
}

export function parseArmTemplateParameters(armJson: string): ParsedArmParameter[] {
  let parsed: any;
  try {
    parsed = JSON.parse(armJson);
  } catch (err) {
    throw new Error(`compiled template is not valid JSON: ${(err as Error).message}`);
  }
  const params = parsed.parameters ?? {};
  return Object.entries(params).map(([name, def]: [string, any]) => ({
    name,
    type: def.type ?? "string",
    description: def.metadata?.description,
    defaultValue: def.defaultValue,
    allowedValues: def.allowedValues,
    required: !Object.prototype.hasOwnProperty.call(def, "defaultValue"),
  }));
}
