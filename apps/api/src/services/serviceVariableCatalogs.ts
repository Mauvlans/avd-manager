/**
 * Static catalogs for "service variables" — the full set of options an
 * admin can choose FROM when narrowing down what's available in
 * deployment forms (per Adam's ask: "list the available regions and an
 * admin can select which ones they want available"). Starting with
 * Azure regions relevant to AVD (Microsoft.DesktopVirtualization is not
 * available in every Azure region — this list is limited to regions
 * where it actually is, per Microsoft's published product-availability
 * data, not the full ~60-region Azure region list).
 *
 * Structured as a Record<variableKey, CatalogEntry[]> so adding a new
 * service variable (VM sizes, timezones, etc.) later is one new entry
 * here, not a schema change — service_variables (004 migration) already
 * stores an arbitrary variable_key + selected_values JSON array per
 * tenant.
 */
export interface CatalogOption {
  value: string;
  label: string;
}

export const SERVICE_VARIABLE_CATALOGS: Record<string, CatalogOption[]> = {
  regions: [
    { value: "eastus", label: "East US" },
    { value: "eastus2", label: "East US 2" },
    { value: "centralus", label: "Central US" },
    { value: "southcentralus", label: "South Central US" },
    { value: "westus2", label: "West US 2" },
    { value: "westus3", label: "West US 3" },
    { value: "canadacentral", label: "Canada Central" },
    { value: "northeurope", label: "North Europe" },
    { value: "westeurope", label: "West Europe" },
    { value: "uksouth", label: "UK South" },
    { value: "francecentral", label: "France Central" },
    { value: "germanywestcentral", label: "Germany West Central" },
    { value: "switzerlandnorth", label: "Switzerland North" },
    { value: "australiaeast", label: "Australia East" },
    { value: "southeastasia", label: "Southeast Asia" },
    { value: "eastasia", label: "East Asia" },
    { value: "japaneast", label: "Japan East" },
    { value: "centralindia", label: "Central India" },
    { value: "uaenorth", label: "UAE North" },
    { value: "southafricanorth", label: "South Africa North" },
    { value: "brazilsouth", label: "Brazil South" },
  ],
};

export function isKnownVariableKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_VARIABLE_CATALOGS, key);
}
