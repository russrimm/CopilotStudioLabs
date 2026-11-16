@description('Existing Azure Container Registry name')
param acrName string

@description('Managed Identity principal ID receiving AcrPull')
param principalId string

@description('Deterministic suffix seed so user/system assignments keep distinct GUIDs')
param roleSeed string = 'acrpull-system'

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, principalId, roleSeed)
  scope: containerRegistry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
