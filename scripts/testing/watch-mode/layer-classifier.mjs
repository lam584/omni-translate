export function resolveLayerVerdict({ activeChecks, layers, environmentReason }) {
  const failed = activeChecks.find(([layer]) => layers[layer].status === 'failed');
  const inconclusive = activeChecks.find(([layer]) => layers[layer].status === 'inconclusive');
  const blocked = environmentReason
    ? (layers.driver.status === 'blocked'
      ? ['driver', layers.driver.reason]
      : ['environment', environmentReason])
    : null;
  const failureLayer = blocked?.[0] ?? failed?.[0] ?? inconclusive?.[0] ?? null;
  return {
    failureLayer,
    verdict: blocked ? 'blocked' : failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed',
  };
}
