# Review Action v2 development and release

The committed runtime default is `REVIEWROUTER_ACTION_V2_MODE=disabled`.
Selecting `t0` is fail-closed unless the generated handoff under
`src/control-plane/generated/review-action-v2/` is present, digest-valid, and
bound to the exact committed SaaS protocol source.

T0 runs through two immutable reusable workflows:

1. `reviewrouter-reusable.yml` is the public customer entrypoint. It validates
   its own repository and full commit SHA before checking out ReviewRouter.
2. `reviewrouter-execution-reusable.yml` is the only producer identity accepted
   by the SaaS v2 OIDC verifier. Wrappers and floating refs are rejected.

The Action owns orchestration, prepared provider invocations, lease renewal,
lease-loss process termination, evidence normalization, projection, and v2 API
calls. The SaaS owns authorization, mutation epochs, evidence acceptance,
publication policy, and durable state. Provider processes never receive GitHub
mutation credentials.

## Projection envelope compatibility

Projection envelope v1 includes `authoritativeObservationIds` so the SaaS can
distinguish the complete accepted observation set from the observations that
happen to emit findings. During a mixed release, omission of this field must not
be interpreted as an empty authoritative set. Older Action bundles remain
eligible only for lanes where investigation production effects and verified
clean replacement are disabled.

Roll out a SaaS parser that accepts and validates the field before promoting the
corresponding Action producer release. Then rebuild and commit `dist/index.js`
and `dist/index.js.map` before registering that release. The production reusable
workflow executes `dist/index.js`; changing TypeScript source without rebuilding
the committed runtime does not update production behavior.

## Cross-repository handoff

After the canonical SaaS protocol artifacts are committed, export them into a
clean Action worktree fenced to its exact branch and base commit:

```bash
pnpm protocol:export-public \
  --action-repo /path/to/review-router \
  --target-branch feat/revision-aware-review-evidence \
  --expected-head ACTION_BASE_SHA \
  --expected-saas-head SAAS_SOURCE_SHA \
  --write
```

Build and test the Action, commit the source, generated handoff, reusable
workflows, and `dist/index.js`, then generate the release manifest outside the
repository:

```bash
pnpm protocol:release-manifest \
  --action-repo /path/to/review-router \
  --target-branch feat/revision-aware-review-evidence \
  --expected-head ACTION_RELEASE_SHA \
  --output /tmp/review-action-v2-release.json
```

Validate that manifest from the SaaS repository before registration:

```bash
pnpm protocol:release-manifest:check \
  --manifest /tmp/review-action-v2-release.json \
  --action-repo /path/to/review-router
```

Never edit the generated handoff or release manifest manually. A release remains
inactive until the SaaS release registry, attestation registry, safety policy,
worker lane, workflow inventory, and mutation epoch all agree on the same full
Action commit SHA.

Investigation capabilities require authorization descriptor V3. A descriptor
without `authorizationDescriptorVersion: 3` is ignored, so mixed-version peers
remain on the ordinary legacy review path without recording, shadow, or critic
authority.

The committed-artifact smoke executes the workflow-wired `dist/index.js` under
a no-network fake boundary. It verifies the full Action commit identity,
runtime artifact digest, OIDC runtime-config exchange, and delivery of all six
strict investigation rollout gates into the production runner. Paired protocol
tests still exercise TypeScript modules directly; both gates are required.

## Deterministic investigation probes

Investigation-capable prepared prompts derive a provider-neutral probe plan from
the untrimmed merge-base-to-head diff and assigned file facts. The v1 planner
covers changed declarations and public identifiers, import/export symbols and
module paths, structured schema/config keys, route/event/permission/cache/feature
identifiers, CRUD and side-effect function names, rename/delete old paths, and a
basename fallback.

Generic identifiers such as `get`, `load`, `read`, `id`, `route`, `data`, and
`result` are rejected by a versioned denylist and minimum-specificity rule before
limits are applied. Queries are globally deduplicated by maximum semantic risk,
then deterministic source-path tie-break, and ordered deterministically.
Production limits are 48 probes per changed file and 384 probes overall.
Exceeding either actual candidate limit produces an incomplete plan with no
partial probes; that invocation remains eligible for the ordinary review path
but is not eligible for investigation recording or authoritative clean
coverage.

The Action emits the strict SaaS v2 obligation wire shapes. Changed-content
requirements use `requirementVersion: 2` and omit legacy `referenceSearch`.
Complete-page-chain requirements use `requirementVersion: 2` and carry the
bounded raw `query`, `queryHash`, `probeKind`, `matchMode: fixed_string`, root
path tuple, page size, head revision, source-path hash, search-policy version,
and initial operation-input hash.

Context Gateway v4 executes text queries with Git fixed-string semantics. The
probe policy and fixed-string search policy versions participate in the
investigation capability profile hash, while each invocation binds the exact
probe-plan hash into its context manifest.

## Investigation observation v2

Codex and Claude Code share one strict investigation turn-output schema and
parser. Both `outputVersion` and the normalized `observationVersion` are `2`.
`obligationProposals` may contain only the server-supported provider-proposable
obligation kinds and canonical `complete_file` requirements. A requirement has
exactly `requirementVersion: 1`, `kind: complete_file`, `path`, the lowercase
SHA-256 digest of the UTF-8 path as `pathHash`, and `revision` (`head` or
`merge_base`). Its canonical subject is the exact canonical JSON `file_read`
subject derived from that path hash and revision. Duplicate identities,
reserved or unknown kinds, unsupported requirements, non-canonical JSON, extra
fields, and path-hash mismatches fail closed. Proposal `riskPriority` is bounded
but advisory; the control plane owns authoritative normalization and critic
policy.

Discovery agents report every complete typed search chain and every additional
complete exploratory text-search chain through `operationBackedDiscoveryClaims`,
containing the source obligation ID, bounded exact query, and the complete
nonempty operation-receipt ID set. All collections remain capped at 256 items
and unknown fields fail closed.

Provider-neutral support does not itself enable a production provider lane.
Claude Code and cross-provider critics remain dormant until the SaaS issues a
separately fenced producer manifest and capability descriptor for the exact
provider/model authority. The Action intersects those server grants with its
local kill switches and never derives critic authority from a Codex parent
manifest.
