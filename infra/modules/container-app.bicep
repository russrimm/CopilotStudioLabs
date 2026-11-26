@description('Container App resource name')
param appName string

@description('Container Apps Managed Environment name')
param environmentName string

@description('Existing User-Assigned Managed Identity resource ID')
param userIdentityId string

@description('User-Assigned Managed Identity client ID used for passwordless Azure Blob RBAC')
param userIdentityClientId string

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

@description('Primary HTTPS Azure Blob endpoint URL for persistent portal state')
param blobEndpoint string

@description('Azure Blob container name used for persistent portal state')
param blobContainerName string = 'portalstate'

@allowed([
  'off'
  'per-user'
  'byok'
])
@description('AI writing mode (AI_GENERATION). Leave off unless the portal has real sign-in or per-user GitHub sign-in is set up; see docs/ai-writing.md. local-user is for a portal on your own PC and is not offered here.')
param aiGeneration string = 'off'

@description('Comma-separated model ids to offer (AI_ALLOWED_MODELS). Empty offers every model the SDK reports.')
param aiAllowedModels string = ''

@description('Address people use to reach the portal (AI_PUBLIC_URL), needed for per-user GitHub sign-in')
param aiPublicUrl string = ''

@description('GitHub App client id (AI_GITHUB_CLIENT_ID) for per-user sign-in')
param aiGithubClientId string = ''

@secure()
@description('GitHub App client secret (AI_GITHUB_CLIENT_SECRET) for per-user sign-in. Stored as a Container Apps secret.')
param aiGithubClientSecret string = ''

@allowed([
  'openai'
  'azure'
  'anthropic'
])
@description('Model provider type for byok (AI_BYOK_TYPE)')
param aiByokType string = 'openai'

@description('https address of the model provider for byok (AI_BYOK_BASE_URL)')
param aiByokBaseUrl string = ''

@description('Models offered for byok (AI_BYOK_MODELS), as id or id=Display name, comma-separated')
param aiByokModels string = ''

@secure()
@description('Model provider key for byok (AI_BYOK_API_KEY). Stored as a Container Apps secret.')
param aiByokApiKey string = ''

// The Copilot SDK runtime is about 200 MB and starts a process per generation, so AI needs more room than the 0.5 CPU / 1Gi the portal runs on without it.
var aiOn = aiGeneration != 'off'
var aiUseGithubSecret = aiOn && !empty(aiGithubClientSecret)
var aiUseByokKey = aiOn && !empty(aiByokApiKey)
var aiSecretList = concat(
  aiUseGithubSecret ? [
    {
      name: 'ai-github-client-secret'
      value: aiGithubClientSecret
    }
  ] : [],
  aiUseByokKey ? [
    {
      name: 'ai-byok-api-key'
      value: aiByokApiKey
    }
  ] : []
)

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
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
      secrets: aiSecretList
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
            cpu: json(aiOn ? '1.0' : '0.5')
            memory: aiOn ? '2Gi' : '1Gi'
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
              name: 'AZURE_CLIENT_ID'
              value: userIdentityClientId
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
            {
              name: 'PORTAL_STORAGE_ROOT'
              value: '/app/portal-storage'
            }
            {
              name: 'PORTAL_STORAGE_BACKEND'
              value: 'azure-blob'
            }
            {
              name: 'AZURE_STORAGE_BLOB_ENDPOINT'
              value: blobEndpoint
            }
            {
              name: 'AZURE_STORAGE_BLOB_CONTAINER'
              value: blobContainerName
            }
            {
              name: 'LAB_BUILDER_OUTPUT_DIR'
              value: '/app/portal-storage/generated-labs'
            }
            {
              name: 'PORTAL_DATA_DIR'
              value: '/app/portal-storage/data'
            }
            {
              name: 'PORTAL_UPLOADS_DIR'
              value: '/app/portal-storage/uploads'
            }
            {
              name: 'AI_GENERATION'
              value: aiGeneration
            }
            {
              name: 'AI_ALLOWED_MODELS'
              value: aiAllowedModels
            }
            {
              name: 'AI_PUBLIC_URL'
              value: aiPublicUrl
            }
            {
              name: 'AI_GITHUB_CLIENT_ID'
              value: aiGithubClientId
            }
            aiUseGithubSecret ? {
              name: 'AI_GITHUB_CLIENT_SECRET'
              secretRef: 'ai-github-client-secret'
            } : {
              name: 'AI_GITHUB_CLIENT_SECRET'
              value: ''
            }
            {
              name: 'AI_BYOK_TYPE'
              value: aiByokType
            }
            {
              name: 'AI_BYOK_BASE_URL'
              value: aiByokBaseUrl
            }
            {
              name: 'AI_BYOK_MODELS'
              value: aiByokModels
            }
            aiUseByokKey ? {
              name: 'AI_BYOK_API_KEY'
              secretRef: 'ai-byok-api-key'
            } : {
              name: 'AI_BYOK_API_KEY'
              value: ''
            }
          ]
        }
      ]
      // Single replica: generated labs, capture jobs, and paired devices live on local disk and are
      // mirrored to Azure Blob at startup and on write, so more than one replica would diverge.
      scale: {
        minReplicas: 1
        maxReplicas: 1
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
