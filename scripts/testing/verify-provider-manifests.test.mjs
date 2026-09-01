import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectFixtureSemantics,
  validateDocumentationUsage,
  validateEnabledProfileFixtureCoverage,
  validateProfileContractCompleteness,
  validateProfileFixtureCoverage,
} from './verify-provider-manifests.mjs';

const profile = {
  id: 'fixture.chat',
  version: 1,
  authProfileIds: ['fixture.auth'],
  audioProfileId: undefined,
};
const lifecycle = {
  clientEvents: ['chat.request'],
  serverEvents: ['chat.chunk', 'data.done'],
};
const authProfiles = new Map([['fixture.auth', {
  id: 'fixture.auth',
  parameters: [{ location: 'header', name: 'Authorization', required: true }],
}]]);

test('scenario prose cannot satisfy structured fixture coverage', () => {
  const fixtures = [{
    scenario: 'endpoint auth request audio response complete done',
    data: { description: 'connection header terminal audio' },
  }];

  const semantics = collectFixtureSemantics(fixtures);
  assert.equal(semantics.endpoints.length, 0);
  assert.equal(semantics.authContracts.length, 0);
  assert.equal(semantics.hasClientPayload, false);
  assert.equal(semantics.hasServerPayload, false);
  assert.throws(
    () => validateEnabledProfileFixtureCoverage(
      profile,
      lifecycle,
      authProfiles,
      fixtures,
      'fixture.chat@1',
    ),
    /lacks a structured secure endpoint URL/,
  );
});

test('profile-aware coverage accepts exact auth and lifecycle evidence', () => {
  const fixtures = [{
    scenario: 'structured stream',
    data: {
      request: {
        event: 'chat.request',
        method: 'POST',
        url: 'https://example.test/v1/chat',
        body: { stream: true },
      },
      authContract: {
        profileId: 'fixture.auth',
        parameters: [
          { location: 'header', name: 'Authorization', value: 'Bearer <redacted>' },
        ],
      },
      response: {
        status: 200,
        frames: [
          { event: 'chat.chunk', data: { delta: 'text' } },
          { data: '[DONE]' },
        ],
      },
    },
  }];

  assert.doesNotThrow(() => validateEnabledProfileFixtureCoverage(
    profile,
    lifecycle,
    authProfiles,
    fixtures,
    'fixture.chat@1',
  ));
});

test('authContract must cover every required parameter of the selected profile', () => {
  const fixtures = [{
    scenario: 'missing auth parameter',
    data: {
      request: { event: 'chat.request', url: 'https://example.test/v1/chat', body: { stream: true } },
      authContract: { profileId: 'fixture.auth', parameters: [] },
      response: { frames: [{ event: 'chat.chunk' }, { data: '[DONE]' }] },
    },
  }];

  assert.throws(
    () => validateEnabledProfileFixtureCoverage(
      profile,
      lifecycle,
      authProfiles,
      fixtures,
      'fixture.chat@1',
    ),
    /does not cover every required parameter/,
  );
});

test('official documentation must be referenced by a provider-owned contract', () => {
  const documentation = new Map([
    ['docs.used', { id: 'docs.used' }],
    ['docs.orphan', { id: 'docs.orphan' }],
  ]);
  const manifest = {
    apiFamilies: [{ id: 'family', documentationIds: ['docs.used'] }],
    protocolProfiles: [],
    models: [],
    fixtures: [],
    authProfiles: [],
  };

  assert.throws(
    () => validateDocumentationUsage(documentation, manifest, 'fixture.manifest'),
    /unreferenced source\(s\): docs\.orphan/,
  );
  manifest.apiFamilies[0].documentationIds.push('docs.orphan');
  assert.doesNotThrow(() => validateDocumentationUsage(documentation, manifest, 'fixture.manifest'));
});

test('disabled audio profiles cannot omit wire fixtures or audio contracts', () => {
  const profile = {
    operations: ['realtime-transcription'],
    fixtureIds: [],
  };
  assert.throws(
    () => validateProfileContractCompleteness(profile, 'fixture.profile'),
    /at least one protocol fixture/,
  );
  profile.fixtureIds.push('fixture.wire');
  assert.throws(
    () => validateProfileContractCompleteness(profile, 'fixture.profile'),
    /requires an explicit audioProfileId/,
  );
  profile.audioProfileId = 'fixture.audio';
  assert.doesNotThrow(() => validateProfileContractCompleteness(profile, 'fixture.profile'));
});

test('unresolved endpoint profiles require explicit fail-closed evidence', () => {
  const unresolved = {
    id: 'fixture.unresolved',
    authProfileIds: ['fixture.auth'],
  };
  const auth = new Map([['fixture.auth', {
    id: 'fixture.auth',
    parameters: [{ location: 'header', name: 'Authorization', required: true }],
  }]]);
  const fixture = {
    data: {
      endpointStatus: 'unresolved',
      networkAuthorized: false,
      authContract: {
        profileId: 'fixture.auth',
        parameters: [{ location: 'header', name: 'Authorization', value: 'Bearer <redacted>' }],
      },
    },
  };
  assert.doesNotThrow(() => validateProfileFixtureCoverage(
    unresolved,
    { endpointStatus: 'unresolved' },
    { clientEvents: [], serverEvents: [] },
    auth,
    [fixture],
    'fixture.unresolved',
  ));
  fixture.data.networkAuthorized = true;
  assert.throws(
    () => validateProfileFixtureCoverage(
      unresolved,
      { endpointStatus: 'unresolved' },
      { clientEvents: [], serverEvents: [] },
      auth,
      [fixture],
      'fixture.unresolved',
    ),
    /must deny network authorization/,
  );
});
