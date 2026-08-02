# Adding a Review Investigation provider

A provider adapter is an anti-corruption layer around the provider process. It
must implement the provider-neutral `ReviewAgentPort` and use Context Gateway v4
for all repository access. Do not add coverage, retry, critic, certificate, or
publication policy to the adapter.

## Required behavior

1. Start a stateless provider process for each turn from the durable dossier.
2. Disable native shell, filesystem, browser, network, plugins, user config, and
   unrelated MCP servers.
3. Expose only the allowlisted Context Gateway v4 tools.
4. Parse a strict turn-observation schema and reject unknown success shapes.
5. Report actual model and trusted usage when the provider supplies them.
6. Map auth, quota, capacity, timeout, cancellation, startup, protocol, and
   infrastructure failures to exhaustive provider-neutral enums.
7. Never include credentials, prompts, repository content, search queries, or
   raw provider envelopes in logs or control-plane payloads.

## Verification

Add the adapter to the shared provider contract suite. It must pass confinement,
cancellation, usage/model attribution, malformed stream, revoked auth, capacity,
startup, timeout, and secret-canary cases using only disposable fixtures.

Provider support is not production-ready until the server registers a compatible
producer release and gateway artifact and the rollout promotion report approves
an explicit cohort.
