/**
 * AI writing: the product and connector names a model may not add to a passage.
 *
 * The guard (guard.js) treats these as protected: any of them in the source must stay, and none may appear that the source
 * did not have. The list is one array, so the guard compiles one pattern for it.
 */

import { listConnectors } from "../lab-builder/connector-names.js";
import { getProducts } from "../lab-builder/products.js";

const STATIC_NAMES = [
  "Microsoft 365 Copilot", "Microsoft 365", "Microsoft Copilot Studio", "Copilot Studio", "Microsoft Copilot", "Power Platform", "Power Apps", "Power Automate",
  "Power BI", "Dataverse", "SharePoint", "OneDrive", "Microsoft Teams", "Teams", "Outlook", "Excel", "PowerPoint", "Azure AI Foundry", "Microsoft Foundry",
  "Azure OpenAI", "Azure", "Microsoft Entra", "Entra ID", "Microsoft Purview", "Microsoft Defender", "Dynamics 365", "GitHub Copilot", "GitHub", "OpenAI", "ChatGPT",
  "Microsoft Fabric", "Salesforce", "ServiceNow", "Zendesk", "Bing", "Anthropic", "Gemini",
];

let namesCache = null;

export function knownNames() {
  if (namesCache) return namesCache;
  const names = new Set(STATIC_NAMES);
  try {
    for (const product of getProducts()) {
      if (product?.name) names.add(product.name);
      if (product?.shortName && product.shortName.length > 4) names.add(product.shortName);
    }
    for (const connector of listConnectors()) if (connector?.displayName && connector.displayName.length > 4) names.add(connector.displayName);
  } catch {
    /* the static list still guards the common ones */
  }
  namesCache = [...names];
  return namesCache;
}

export function resetKnownNames() {
  namesCache = null;
}
