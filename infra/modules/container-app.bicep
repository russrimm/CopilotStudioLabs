@description('Container App resource name')
param appName string

@description('Container Apps Managed Environment name')
param environmentName string

@description('Existing User-Assigned Managed Identity resource ID')
param userIdentityId string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('AZD service name tag value')
param serviceName string = 'portal'

@description('Container image reference')
param containerImageName string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Existing Log Analytics workspace name in the same resource group')
param logAnalyticsWorkspaceName string

@description('Azure Container Registry login server (e.g. myacr.azurecr.io)')
param containerRegistryLoginServer string

@description('Application Insights connection string')
param applicationInsightsConnectionString string = ''

@description('Whether bearer-token API auth is disabled for open demo access')
param portalAuthDisabled bool = true

@description('Azure subscription ID exposed to portal config view')
param azureSubscriptionId string = ''

@description('Azure tenant ID exposed to portal config view')
param azureTenantId string = ''

@description('Existing Azure Storage account name in the same resource group for persistent portal state')
param storageAccountName string

@description('Azure Files share name mounted into the portal container')
param fileShareName string = 'portalstate'

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppsEnvironment
  name: 'portalstate'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: union(tags, {
    'azd-service-name': serviceName
  })
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${userIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: containerRegistryLoginServer
          identity: userIdentityId
        }
      ]
      ingress: {
        external: true
        targetPort: 3005
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: serviceName
          image: containerImageName
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'HOST'
              value: '0.0.0.0'
            }
            {
              name: 'PORT'
              value: '3005'
            }
            {
              name: 'PORTAL_AUTH_DISABLED'
              value: portalAuthDisabled ? 'true' : 'false'
            }
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: azureSubscriptionId
            }
            {
              name: 'AZURE_TENANT_ID'
              value: azureTenantId
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
            {
              name: 'PORTAL_STORAGE_ROOT'
              value: '/mnt/portal-storage'
            }
            {
              name: 'PORTAL_STORAGE_BACKEND'
              value: 'azure-files'
            }
            {
              name: 'LAB_BUILDER_OUTPUT_DIR'
              value: '/mnt/portal-storage/generated-labs'
            }
            {
              name: 'PORTAL_DATA_DIR'
              value: '/mnt/portal-storage/data'
            }
            {
              name: 'PORTAL_UPLOADS_DIR'
              value: '/mnt/portal-storage/uploads'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'portal-storage'
              mountPath: '/mnt/portal-storage'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'portal-storage'
          storageType: 'AzureFile'
          storageName: envStorage.name
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '30'
              }
            }
          }
        ]
      }
    }
  }
}

output id string = containerApp.id
output name string = containerApp.name
output environmentName string = containerAppsEnvironment.name
output uri string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output systemAssignedMIPrincipalId string = containerApp.identity.principalId
