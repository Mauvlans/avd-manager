// rbac-delegation.bicep
//
// Grant (b) of the two-grant onboarding model (see README). The customer's
// admin deploys this template into their own subscription via a "Deploy to
// Azure" button/link. It creates:
//   1. A custom RBAC role definition scoped to ONLY the AVD/Compute VM
//      actions our app needs — never Owner or Contributor.
//   2. A role assignment of that custom role to our multi-tenant app's
//      service principal, scoped to this subscription (optionally further
//      scoped to specific resource groups by deploying at RG scope instead).
//
// This template deliberately does NOT use Azure Lighthouse — see README for
// why. It is a plain custom role + role assignment in the customer's own
// tenant, fully visible/auditable/revocable via their own Azure Portal IAM
// blade (no separate delegation blade to reason about).

targetScope = 'subscription'

@description('Object ID of the service principal for the AVD Manager multi-tenant app registration in this tenant (created by the Graph admin-consent step).')
param avdManagerServicePrincipalObjectId string

@description('A short, unique suffix to avoid role definition name collisions across repeated deployments.')
param roleNameSuffix string = uniqueString(subscription().id)

@description('Correlation id / tenant id passed back to our callback so we can record the grant in subscriptions_registry.')
param tenantCallbackState string = ''

var roleName = 'AVD Manager - Least Privilege (${roleNameSuffix})'

resource avdManagerCustomRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, roleName)
  properties: {
    roleName: roleName
    description: 'Least-privilege role for AVD Manager SaaS: host pool + session host VM lifecycle management only. Never Owner/Contributor.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          // Microsoft.DesktopVirtualization/* — host pools, session hosts,
          // application groups, workspaces, scaling plans.
          'Microsoft.DesktopVirtualization/*'
          // Microsoft.Compute/virtualMachines/* — start/stop/deallocate the
          // underlying session host VMs for autoscaling. Deliberately scoped
          // to the virtualMachines/* sub-resource, not all of Microsoft.Compute.
          'Microsoft.Compute/virtualMachines/*'
          // Needed to read VM instance view (power state) for scaling decisions.
          'Microsoft.Compute/virtualMachines/instanceView/read'
          // Needed to resolve VM -> NIC -> resource group context in some ARM calls.
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          // Needed by the periodic permission health-check job
          // (permissionHealthCheck.ts / armRoleAssignmentVerifier.ts) to list
          // role assignments at this subscription scope and confirm THIS
          // grant is still present/unmodified — read-only, does not grant
          // any ability to create/modify/delete role assignments. Found to
          // be missing live: without it, ARM's roleAssignments list call
          // silently returns an empty list rather than an explicit
          // permission error, making the app unable to verify its own
          // grant at all (a real chicken-and-egg gap in the original
          // least-privilege role, not a bug in the verifier code itself).
          'Microsoft.Authorization/roleAssignments/read'
          // Needed for the Cost Optimization platform's Phase 2 cost
          // ingestion (armCostManagementClient.ts) — Microsoft.CostManagement's
          // query API. Found to be missing live: the very first real cost
          // ingestion attempt against Adam's subscription failed with a
          // genuine 401 RBACAccessDenied, because the role as originally
          // scoped had no Cost Management permissions at all (matches the
          // Cost Optimization plan's own § 3.1 guidance that Cost
          // Management Reader is a SEPARATE recommended role from the AVD
          // management ones — this was never granted). query/action is the
          // read-only action needed to call the Query API; it does not
          // grant any ability to modify billing/cost configuration.
          'Microsoft.CostManagement/query/action'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

resource avdManagerRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, avdManagerServicePrincipalObjectId, avdManagerCustomRole.id)
  properties: {
    roleDefinitionId: avdManagerCustomRole.id
    principalId: avdManagerServicePrincipalObjectId
    principalType: 'ServicePrincipal'
  }
}

output roleDefinitionId string = avdManagerCustomRole.id
output roleAssignmentId string = avdManagerRoleAssignment.id
output subscriptionId string = subscription().subscriptionId
output tenantCallbackState string = tenantCallbackState
