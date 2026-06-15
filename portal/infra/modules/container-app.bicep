// ── Container App module for MCP servers ──────────────────────────────────

@description('Container App name')
param name string

@description('Azure region')
param location string

@description('Resource tags')
param tags object = {}

@description('Container image')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('CPU cores')
param cpu string = '0.5'

@description('Memory')
param memory string = '1Gi'

@description('Min replicas (0 = scale to zero)')
param minReplicas int = 0

@description('Max replicas')
param maxReplicas int = 1

@description('Environment variables as key-value pairs')
param envVars array = []

// ── Container Apps Environment ────────────────────────────────────────────
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
  }
}

// ── Log Analytics Workspace ───────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Container App ─────────────────────────────────────────────────────────
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3005
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: name
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: envVars
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appId string = app.id
