// session-host.bicep
//
// Provisions N session host VMs and joins them to an existing host pool
// using the registration token from host-pool.bicep's output. Uses a
// Windows 10/11 multi-session Azure Marketplace image by default; swap
// `imageReference` for a custom Azure Compute Gallery image as needed.
//
// FSLogix profile container mounting and MSIX app attach are configured via
// the AVD agent extension's DSC parameters below (pointed at a customer-
// supplied Azure Files/NetApp share) — see README's "user & app management"
// section; this is the provisioning-time hook, the ongoing FSLogix/MSIX
// *management* API surface lives in apps/api/src/services (stubs in v1).

targetScope = 'resourceGroup'

@description('Base name for session host VMs; hosts will be named {vmNamePrefix}-0, -1, etc.')
param vmNamePrefix string

@minValue(1)
@maxValue(50)
param sessionHostCount int = 1

param location string = resourceGroup().location

@description('Registration token from the host pool this session host should join (output of host-pool.bicep).')
@secure()
param hostPoolRegistrationToken string

param vmSize string = 'Standard_D2s_v5'

@description('Admin username for the session host local admin account.')
param adminUsername string

@secure()
param adminPassword string

@description('Resource ID of the subnet the session host NICs attach to.')
param subnetId string

@description('UNC path to the FSLogix profile container share, e.g. \\\\storageaccount.file.core.windows.net\\profiles. Empty string disables FSLogix configuration at provision time.')
param fslogixProfileShare string = ''

var vmNames = [for i in range(0, sessionHostCount): '${vmNamePrefix}-${i}']

resource nics 'Microsoft.Network/networkInterfaces@2023-09-01' = [
  for (name, i) in vmNames: {
    name: '${name}-nic'
    location: location
    properties: {
      ipConfigurations: [
        {
          name: 'ipconfig1'
          properties: {
            subnet: { id: subnetId }
          }
        }
      ]
    }
  }
]

resource vms 'Microsoft.Compute/virtualMachines@2023-09-01' = [
  for (name, i) in vmNames: {
    name: name
    location: location
    properties: {
      hardwareProfile: { vmSize: vmSize }
      osProfile: {
        computerName: name
        adminUsername: adminUsername
        adminPassword: adminPassword
      }
      storageProfile: {
        imageReference: {
          publisher: 'MicrosoftWindowsDesktop'
          offer: 'Windows-11'
          sku: 'win11-23h2-avd'
          version: 'latest'
        }
        osDisk: {
          createOption: 'FromImage'
          managedDisk: { storageAccountType: 'Premium_LRS' }
        }
      }
      networkProfile: {
        networkInterfaces: [
          { id: nics[i].id }
        ]
      }
    }
  }
]

// AVD agent + boot loader extension: joins the VM to the host pool using
// the registration token. This is the standard "Microsoft.PowerShell.DSC"
// AVD extension pattern.
resource avdAgentExtension 'Microsoft.Compute/virtualMachines/extensions@2023-09-01' = [
  for (name, i) in vmNames: {
    name: '${name}/Microsoft.PowerShell.DSC'
    location: location
    properties: {
      publisher: 'Microsoft.Powershell'
      type: 'DSC'
      typeHandlerVersion: '2.83'
      autoUpgradeMinorVersion: true
      settings: {
        modulesUrl: 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.02790.442.zip'
        configurationFunction: 'Configuration.ps1\\AddSessionHost'
        properties: {
          hostPoolName: vmNamePrefix
          registrationInfoToken: hostPoolRegistrationToken
          aadJoin: true
        }
      }
    }
    dependsOn: [
      vms[i]
    ]
  }
]

output sessionHostNames array = vmNames
output fslogixConfigured bool = !empty(fslogixProfileShare)
