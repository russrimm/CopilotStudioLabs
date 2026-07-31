/**
 * Optional LLM enrichment for the lab builder.
 *
 * Provider auto-detection order:
 *   1. Azure OpenAI  — AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT
 *   2. GitHub Models — GITHUB_TOKEN (or GITHUB_MODELS_TOKEN)
 *   3. none          — deterministic composition from the catalog + Learn excerpts
 *
 * The lab builder works fully without any provider configured; the LLM only
 * adds scenario-specific narrative on top of grounded content.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.LAB_BUILDER_LLM_TIMEOUT_MS || 60000);

export function detectProvider(env = process.env) {
  if (String(env.LAB_BUILDER_LLM || "").toLowerCase() === "off") {
    return { kind: "none", reason: "Disabled via LAB_BUILDER_LLM=off" };
  }

  if (env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_DEPLOYMENT) {
    return {
      kind: "azure-openai",
      label: `Azure OpenAI (${env.AZURE_OPENAI_DEPLOYMENT})`,
      endpoint: env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, ""),
      apiKey: env.AZURE_OPENAI_API_KEY,
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: env.AZURE_OPENAI_API_VERSION || "2024-10-21",
    };
  }

  const ghToken = env.GITHUB_MODELS_TOKEN || env.GITHUB_TOKEN;
  if (ghToken) {
    return {
      kind: "github-models",
      label: `GitHub Models (${env.GITHUB_MODELS_MODEL || "openai/gpt-4o-mini"})`,
      endpoint: env.GITHUB_MODELS_ENDPOINT || "https://models.github.ai/inference",
      apiKey: ghToken,
      model: env.GITHUB_MODELS_MODEL || "openai/gpt-4o-mini",
    };
  }

  return {
    kind: "none",
    reason: "No AZURE_OPENAI_* or GITHUB_TOKEN found — using deterministic Learn-grounded composition",
  };
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function extractMessage(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * Create a completion function for the detected provider.
 * Returns `{ provider, available, complete(system, user, opts) }`.
 * `complete` always resolves — it returns "" when unavailable or on error.
 */
export function createLlm(env = process.env) {
  const provider = detectProvider(env);
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  if (provider.kind === "none") {
    return {
      provider,
      available: false,
      async complete() {
        return "";
      },
    };
  }

  return {
    provider,
    available: true,
    async complete(system, user, { maxTokens = 1600, temperature = 0.4 } = {}) {
      const messages = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];

      try {
        if (provider.kind === "azure-openai") {
          const url = `${provider.endpoint}/openai/deployments/${encodeURIComponent(
            provider.deployment,
          )}/chat/completions?api-version=${encodeURIComponent(provider.apiVersion)}`;
          const payload = await postJson(
            url,
            { "api-key": provider.apiKey },
            { messages, max_tokens: maxTokens, temperature },
            timeoutMs,
          );
          return extractMessage(payload);
        }

        const payload = await postJson(
          `${provider.endpoint.replace(/\/+$/, "")}/chat/completions`,
          { authorization: `Bearer ${provider.apiKey}` },
          { model: provider.model, messages, max_tokens: maxTokens, temperature },
          timeoutMs,
        );
        return extractMessage(payload);
      } catch {
        return "";
      }
    },
  };
}
