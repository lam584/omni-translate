import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const registry = JSON.parse(fs.readFileSync(
  new URL('../../contracts/model-protocol-profiles.v1.json', import.meta.url),
  'utf8',
));

const benchmarkRunner = fs.readFileSync(
  new URL('../../apps/desktop/src-tauri/src/benchmark/runners.rs', import.meta.url),
  'utf8',
);
const dashscopeAdapter = fs.readFileSync(
  new URL('../../apps/desktop/src-tauri/src/provider/gateway_parts/dashscope.rs', import.meta.url),
  'utf8',
);
const liveTranslateProbe = fs.readFileSync(
  new URL(
    '../../apps/desktop/src-tauri/src/provider/gateway_parts/dashscope/livetranslate_probe.rs',
    import.meta.url,
  ),
  'utf8',
);
const providerGateway = fs.readFileSync(
  new URL('../../apps/desktop/src-tauri/src/provider/gateway.rs', import.meta.url),
  'utf8',
);

function rustFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function firstAuthorization(source) {
  return [
    'authorize_bailian_model_operation',
    'authorize_bailian_native_translate',
    'authorize_model_protocol_invocation',
  ]
    .map((marker) => source.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0] ?? -1;
}

const enabledProfile = registry.profiles.find(
  (profile) => profile.adapter.status === 'enabled',
);
const enabledDialect = registry.dialects.find(
  (dialect) => dialect.dialectId === enabledProfile?.dialectId,
);

test('adversarial: DashScope benchmark must authorize the exact invocation before connect', () => {
  assert.equal(enabledProfile?.profileId, 'bailian.livetranslate.realtime.ws');
  const benchmarkEntry = rustFunction(
    benchmarkRunner,
    'pub(crate) async fn run_model_benchmark(',
    'struct IntermediateResult',
  );
  const productionDashscopeBranch = rustFunction(
    benchmarkRunner,
    'fn run_single_benchmark(',
    'fn run_single_openai_benchmark(',
  );
  const entryAuthorization = firstAuthorization(benchmarkEntry);
  const paidDispatch = benchmarkEntry.indexOf('run_single_benchmark(');
  const leafAuthorization = firstAuthorization(productionDashscopeBranch);
  const connection = productionDashscopeBranch.indexOf('connect_benchmark_websocket');

  assert.notEqual(connection, -1, 'counterexample must reach the production connector');
  assert.ok(
    (entryAuthorization !== -1 && entryAuthorization < paidDispatch)
      || (leafAuthorization !== -1 && leafAuthorization < connection),
    'DashScope benchmark connects from inspection-derived URL without exact model/operation/region/host/adapter authorization',
  );
});

test('adversarial: DashScope HTTP gateway must authorize before the paid POST boundary', () => {
  const dashscopeExecute = rustFunction(
    dashscopeAdapter,
    'pub(super) fn execute(',
    'fn execute_websocket(',
  );
  const authorization = firstAuthorization(dashscopeExecute);
  const paidPost = dashscopeExecute.indexOf('client.post_json');
  const gatewayDispatch = rustFunction(
    providerGateway,
    'fn execute_smoke_with_delta(',
    '#[allow(dead_code',
  );
  const gatewayAuthorization = firstAuthorization(gatewayDispatch);
  const adapterDispatch = gatewayDispatch.indexOf('self.dashscope_adapter.execute');

  assert.notEqual(paidPost, -1, 'counterexample must reach the production HTTP POST');
  assert.ok(
    (authorization !== -1 && authorization < paidPost)
      || (gatewayAuthorization !== -1 && gatewayAuthorization < adapterDispatch),
    'DashScope HTTP gateway sends unknown/manifest-only voice models without exact operation/transport/region/host/adapter authorization',
  );
});

test('adversarial: enabled LiveTranslate gateway must not send a forbidden Omni text event', () => {
  assert.ok(enabledDialect?.forbiddenClientEventTypes.includes('conversation.item.create'));
  const realtimeGateway = rustFunction(
    liveTranslateProbe,
    'pub(super) fn execute_livetranslate_session_probe(',
    'fn handle_livetranslate_json_frame(',
  );
  const forbiddenEventBuilder = realtimeGateway.indexOf('build_dashscope_text_item');
  const eventAdmission = realtimeGateway.indexOf('admit_model_protocol_event');
  const itemSend = realtimeGateway.indexOf('send_json_frame', forbiddenEventBuilder);

  assert.ok(
    forbiddenEventBuilder === -1
      || (eventAdmission > forbiddenEventBuilder && eventAdmission < itemSend),
    'LiveTranslate gateway connects first and then emits manifest-forbidden conversation.item.create',
  );
});

test('adversarial: enabled LiveTranslate gateway must reject Omni delta semantics', () => {
  assert.ok(enabledDialect?.forbiddenServerEventTypes.includes('response.text.delta'));
  const realtimeGateway = rustFunction(
    liveTranslateProbe,
    'pub(super) fn execute_livetranslate_session_probe(',
    'fn handle_livetranslate_json_frame(',
  );
  const forbiddenDelta = realtimeGateway.indexOf('"response.text.delta"');
  const eventAdmission = realtimeGateway.indexOf('admit_model_protocol_event');

  assert.ok(
    forbiddenDelta === -1 || (eventAdmission !== -1 && eventAdmission < forbiddenDelta),
    'LiveTranslate gateway accepts the manifest-forbidden Omni delta event without event admission',
  );
});

test('adversarial: enabled LiveTranslate gateway must finish its required terminal lifecycle', () => {
  assert.equal(enabledDialect?.terminalLifecycle, 'session.finish->session.finished');
  const realtimeGateway = rustFunction(
    liveTranslateProbe,
    'pub(super) fn execute_livetranslate_session_probe(',
    'fn handle_livetranslate_json_frame(',
  );

  assert.ok(
    liveTranslateProbe.includes('session.finish')
      && liveTranslateProbe.includes('session.finished')
      && liveTranslateProbe.includes('AwaitSessionFinished'),
    'ordinary LiveTranslate smoke/translation returns after response.done and drops the socket without session.finish -> session.finished',
  );
});
