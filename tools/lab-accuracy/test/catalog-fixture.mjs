// A clean `out/catalog.json` for tests that run build-issue.mjs.
//
// The lab-builder catalog report fails closed (issue #42): without one, every
// month needs a maintainer. Fixtures that expect "no action" therefore write
// this alongside their other reports.

export function cleanCatalogReport({ summary = {}, feature = {} } = {}) {
  return {
    maxAgeDays: 180,
    summary: {
      features: 1,
      links: 2,
      brokenLinks: 0,
      unreachableLinks: 0,
      refusedLinks: 0,
      unverifiableLinks: 0,
      redirectedLinks: 0,
      staleFeatures: 0,
      unverifiedFeatures: 0,
      oldestVerification: { id: "create-agent", lastVerified: "2026-09-27", ageDays: 0 },
      ...summary,
    },
    features: [
      {
        id: "create-agent",
        lastVerified: "2026-09-27",
        verifiedAgainst: "https://learn.example.test/create",
        ageDays: 0,
        stale: false,
        verificationProblems: [],
        brokenLinks: [],
        unreachableLinks: [],
        refusedLinks: [],
        unverifiableLinks: [],
        redirectedLinks: [],
        ...feature,
      },
    ],
  };
}
