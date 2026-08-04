'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const witnessPath = requireEnv('RR_ARTIFACT_SMOKE_WITNESS_PATH');
const expectedArtifactPath = fs.realpathSync(
  requireEnv('RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT')
);
const expectedArtifactSha256 = requireEnv(
  'RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT_SHA256'
);
const expectedActionVersion = requireEnv(
  'RR_ARTIFACT_SMOKE_EXPECTED_ACTION_VERSION'
);
const artifactPath = fs.realpathSync(process.argv[1]);
const artifactSha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(artifactPath))
  .digest('hex');
const state = {
  artifactPath,
  artifactSha256,
  expectedActionVersion,
  networkGuardsInstalled: false,
  calls: [],
};

process.once('exit', () => persist());

assertEqual(artifactPath, expectedArtifactPath, 'artifact_path_mismatch');
assertEqual(artifactSha256, expectedArtifactSha256, 'artifact_digest_mismatch');
if (!/^[a-f0-9]{40}$/.test(expectedActionVersion)) {
  fail('action_version_not_immutable');
}

installNetworkGuards();
globalThis.fetch = fakeFetch;
persist();

async function fakeFetch(resource, init = {}) {
  const url = new URL(requestUrl(resource));
  const method = requestMethod(resource, init);
  const headers = requestHeaders(resource, init);
  const call = { method, origin: url.origin, pathname: url.pathname };
  state.calls.push(call);
  persist();

  try {
    const key = `${method} ${url.origin}${url.pathname}`;
    switch (key) {
      case 'GET https://oidc.actions.test/token':
        assertEqual(
          url.searchParams.get('audience'),
          'reviewrouter',
          'oidc_audience_mismatch'
        );
        return jsonResponse({ value: 'fake-oidc-token' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/prelease':
        return jsonResponse({
          protocolVersion: 1,
          leaseId: 'lease:artifact-smoke',
          providerInstanceId: 'codex-rotating:artifact-smoke',
          repository: 'sandbox/repository',
          generationHashSalt: Buffer.from(
            'artifact-smoke-generation-salt-32'
          ).toString('base64url'),
          currentGeneration: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/finalize':
        return jsonResponse({
          protocolVersion: 1,
          leaseId: 'lease:artifact-smoke',
          nextGeneration: 2,
          status: 'finalized',
          repositoryOwner: 'sandbox',
          repositoryName: 'repository',
          publicKeyReadToken: 'fake-public-key-read-token',
          publicKeyReadTokenExpiresAt: '2099-01-01T00:00:00.000Z',
        });
      case 'GET https://api.github.com/repos/sandbox/repository/actions/secrets/public-key':
        return jsonResponse({
          key_id: 'artifact-smoke-key',
          key: requireEnv('RR_ARTIFACT_SMOKE_PUBLIC_KEY'),
        });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback-preflight':
        return jsonResponse({ protocolVersion: 1, status: 'ready' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback':
        return jsonResponse({ protocolVersion: 1, status: 'accepted' });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/checkout-token':
        return jsonResponse({
          protocolVersion: 1,
          token: 'fake-read-only-checkout-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          repository: 'sandbox/repository',
          permissions: { contents: 'read', pullRequests: 'read' },
        });
      case 'POST https://control-plane.reviewrouter.test/api/action/v1/session/exchange':
        return jsonResponse({ sessionToken: 'fake-action-session' });
      case 'GET https://control-plane.reviewrouter.test/api/action/v1/config': {
        const actionVersion = headers.get('x-reviewrouter-action-version');
        assertEqual(
          actionVersion,
          expectedActionVersion,
          'runtime_config_action_version_mismatch'
        );
        assertEqual(
          headers.get('authorization'),
          'Bearer fake-action-session',
          'runtime_config_session_mismatch'
        );
        state.runtimeConfig = {
          actionVersion,
          configVersion: 4242,
          providerLimit: '987654321',
        };
        persist();
        return jsonResponse({
          protocolVersion: 1,
          configVersion: 4242,
          runtimeEnv: {
            PROVIDER_LIMIT: '987654321',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED:
              '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: '1',
          },
        });
      }
      default:
        fail(`unexpected_fetch:${key}`);
    }
  } catch (error) {
    if (!state.failure) {
      state.failure = error instanceof Error ? error.message : String(error);
      persist();
    }
    throw error;
  }
}

function installNetworkGuards() {
  const blocked = () => {
    throw new Error('artifact_smoke_real_network_forbidden');
  };
  http.request = blocked;
  http.get = blocked;
  https.request = blocked;
  https.get = blocked;
  net.connect = blocked;
  net.createConnection = blocked;
  tls.connect = blocked;
  state.networkGuardsInstalled = true;
}

function requestUrl(resource) {
  if (typeof resource === 'string' || resource instanceof URL) {
    return String(resource);
  }
  return resource.url;
}

function requestMethod(resource, init) {
  if (init.method) return String(init.method).toUpperCase();
  if (typeof Request !== 'undefined' && resource instanceof Request) {
    return resource.method.toUpperCase();
  }
  return 'GET';
}

function requestHeaders(resource, init) {
  const headers = new Headers(
    typeof Request !== 'undefined' && resource instanceof Request
      ? resource.headers
      : undefined
  );
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function fail(message) {
  state.failure = message;
  persist();
  throw new Error(message);
}

function persist() {
  state.investigationRollout = {
    recording:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED ?? null,
    shadow:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED ?? null,
    contextCritic:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED ??
      null,
    verifiedClean:
      process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED ??
      null,
    crossRevisionReplay:
      process.env
        .REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED ??
      null,
    productionEffects:
      process.env
        .REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED ?? null,
  };
  fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
  fs.writeFileSync(witnessPath, `${JSON.stringify(state, null, 2)}\n`);
}
