// host-pool.bicep
//
// Provisions an AVD host pool (and optionally an application group /
// workspace association) in a customer subscription. Session hosts
// themselves (the underlying VMs + AVD agent registration) are provisioned
// by a separate template (session-host.bicep) since they scale
// independently of the pool.

targetScope = 'resourceGroup'

@description('Name of the host pool.')
param hostPoolName string

@description('Azure region for the host pool metadata object (session hosts can be in the same or a paired region).')
param location string = resourceGroup().location

@allowed(['Personal', 'Pooled'])
param hostPoolType string = 'Pooled'

@allowed(['BreadthFirst', 'DepthFirst', 'Persistent'])
param loadBalancerType string = 'BreadthFirst'

@minValue(1)
@maxValue(999)
param maxSessionLimit int = 10

@description('Validity period in hours for the registration token issued to session hosts joining this pool.')
@minValue(1)
@maxValue(2160)
param registrationTokenValidityHours int = 24

resource hostPool 'Microsoft.DesktopVirtualization/hostPools@2023-09-05' = {
  name: hostPoolName
  location: location
  properties: {
    hostPoolType: hostPoolType
    loadBalancerType: loadBalancerType
    maxSessionLimit: maxSessionLimit
    preferredAppGroupType: 'Desktop'
    registrationInfo: {
      expirationTime: dateTimeAdd(utcNow('u'), 'PT${registrationTokenValidityHours}H')
      registrationTokenOperation: 'Update'
    }
    personalDesktopAssignmentType: hostPoolType == 'Personal' ? 'Automatic' : null
  }
}

output hostPoolId string = hostPool.id
output hostPoolName string = hostPool.name
@secure()
output registrationToken string = hostPool.properties.registrationInfo.token
