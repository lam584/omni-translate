// Core DiagnosticsPage helper coverage: status/label maps, runtime environment
// summaries, overview issues/signals and service monitor badges. Benchmark
// rendering lives in DiagnosticsPage.helpers.benchmark.test.ts and
// LiveSessionEventDetail/export coverage in
// DiagnosticsPage.helpers.live-events.test.ts; shared fixtures in
// ../test-utils/diagnostics-page-fixtures.
import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { diagnosticsPageHelpers } from './DiagnosticsPage';

describe('diagnostics page helpers', () => {
  it('maps all status, bridge, capture, driver and rank labels', () => {
    expect(['ready', 'warning', 'stable', 'experimental', 'unsupported', 'draft', 'preview', 'other'].map(diagnosticsPageHelpers.resolveStatusTone))
      .toEqual(['ready', 'warning', 'stable', 'experimental', 'unsupported', 'draft', 'draft', 'unknown']);
    expect(['ready', 'warning', 'stable', 'experimental', 'unsupported', 'draft', 'preview', 'other'].map(diagnosticsPageHelpers.formatStatusLabel))
      .toEqual(['已就绪', '需关注', '稳定', '实验性', '不支持', '未完成', '未完成', '未知']);
    expect(['running', 'starting', 'degraded', 'stopped'].map(diagnosticsPageHelpers.formatBridgeStateLabel))
      .toEqual(['运行中', '启动中', '降级', '已停止']);
    expect(['capturing', 'buffering', 'armed', 'muted', 'idle'].map(diagnosticsPageHelpers.formatCaptureStateLabel))
      .toEqual(['采集中', '缓冲中', '待命', '静音', '空闲']);
    expect(['running', 'version-mismatch', 'damaged', 'not-installed'].map(diagnosticsPageHelpers.formatDriverHealthLabel))
      .toEqual(['运行正常', '版本不匹配', '已损坏', '未安装']);
    expect(['risk', 'unsupported', 'warning', 'pending', 'draft', 'unknown', 'ready'].map((tone) => diagnosticsPageHelpers.getIssueToneRank(tone as never)))
      .toEqual([5, 4, 3, 2, 2, 1, 0]);
  });

  it('compares ids and detects overlay visibility', () => {
    expect(diagnosticsPageHelpers.hasSameIds(['a'], ['a'])).toBe(true);
    expect(diagnosticsPageHelpers.hasSameIds(['a'], ['a', 'b'])).toBe(false);
    expect(diagnosticsPageHelpers.hasSameIds(['a'], ['b'])).toBe(false);
    const visible = structuredClone(runtimeSnapshotMock);
    visible.windows = visible.windows.map((item) => item.label === 'subtitle-overlay' ? { ...item, visible: true } : item);
    expect(diagnosticsPageHelpers.isOverlayVisible(visible)).toBe(true);
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.windows = [];
    expect(diagnosticsPageHelpers.isOverlayVisible(snapshot)).toBe(false);
  });

  it('summarizes preview, runtime errors, ready desktop and all actionable desktop issues', () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(structuredClone(runtimeSnapshotMock), audio).mode).toBe('browser-preview');

    const runtimeError = structuredClone(runtimeSnapshotMock);
    runtimeError.bridgeStatus = 'runtime-error';
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(runtimeError, audio).mode).toBe('runtime-error');

    const ready = structuredClone(runtimeSnapshotMock);
    ready.bridgeStatus = 'tauri-shell';
    ready.bridge.driverHealth = 'running';
    ready.bridge.lifecycleState = 'ready';
    ready.bridge.lastErrorCode = null;
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(ready, audio).mode).toBe('live-ready');

    const damaged = structuredClone(ready);
    damaged.bridge.driverHealth = 'damaged';
    damaged.bridge.lifecycleState = 'error';
    damaged.bridge.lastErrorCode = 'bridge.session-mismatch';
    const failedAudio = structuredClone(audio);
    failedAudio.inbound.lastError = 'inbound';
    failedAudio.outbound.lastError = 'outbound';
    failedAudio.speech.lastError = 'speech';
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(damaged, failedAudio)).toMatchObject({
      mode: 'live-action-needed',
      details: expect.arrayContaining([
        '虚拟麦驱动状态损坏，需要重新安装。',
        'Bridge Service 返回错误：bridge.session-mismatch',
        '系统音频采集异常：inbound',
        '麦克风采集异常：outbound',
        '语音播报异常：speech',
      ]),
    });

    const mismatched = structuredClone(ready);
    mismatched.bridge.driverHealth = 'version-mismatch';
    const monitorLoop = structuredClone(ready);
    monitorLoop.bridge.lastErrorCode = 'monitor.virtual-playback-loop';
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(monitorLoop, audio)).toMatchObject({
      mode: 'live-action-needed',
      details: expect.arrayContaining([expect.stringContaining('Omni')]),
    });
    expect(diagnosticsPageHelpers.getRuntimeEnvironmentSummary(mismatched, audio).details).toContain('桥接驱动版本不匹配，需要按推荐动作修复。');
  });

  it('does not treat an optional damaged bridge as a conversation-mode blocker', () => {
    const runtime = structuredClone(runtimeSnapshotMock);
    const audio = structuredClone(audioRuntimeSnapshotMock);
    const config = structuredClone(appConfigDraftMock);
    runtime.bridgeStatus = 'tauri-shell';
    runtime.bridge.driverHealth = 'damaged';
    runtime.bridge.lifecycleState = 'error';
    runtime.bridge.lastErrorCode = 'driver.not-installed';
    config.devices.routeMode = 'voice-room';
    config.devices.feedbackLoopPrevention = 'echo-cancel';

    const summary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(runtime, audio, config);
    expect(summary.mode).toBe('live-ready');
    expect(diagnosticsPageHelpers.buildOverviewIssues(runtime, audio, summary, config)).toEqual([]);
  });

  it('builds deduplicated overview issues and signal summaries', () => {
    const runtime = structuredClone(runtimeSnapshotMock);
    const audio = structuredClone(audioRuntimeSnapshotMock);
    runtime.bridgeStatus = 'tauri-shell';
    runtime.bridge.driverHealth = 'running';
    runtime.bridge.bridgeState = 'running';
    runtime.bridge.lifecycleState = 'ready';
    runtime.bridge.lastErrorCode = null;
    runtime.diagnostics.deviceStatus = 'ready';
    runtime.diagnostics.recentErrors = [];
    audio.inbound.lastError = null;
    audio.outbound.lastError = null;
    audio.speech.lastError = null;
    const readySummary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(runtime, audio);

    expect(diagnosticsPageHelpers.buildOverviewIssues(runtime, audio, readySummary)).toEqual([]);
    expect(diagnosticsPageHelpers.buildOverviewSignals(runtime, audio, readySummary, 'live-ready')).toMatchObject([
      { label: '运行环境', tone: 'ready' },
      { label: '桥接', tone: 'ready' },
      { label: '采集', tone: 'ready' },
      { label: '错误摘要', value: '最近无新错误', meta: '平稳', tone: 'ready' },
    ]);

    runtime.bridge.driverHealth = 'damaged';
    runtime.bridge.lifecycleState = 'error';
    runtime.bridge.lastErrorCode = 'bridge.session-mismatch';
    audio.inbound.lastError = 'input failed';
    audio.inbound.recommendedAction = 'restart-bridge';
    audio.outbound.lastError = 'output failed';
    audio.outbound.recommendedAction = null;
    audio.speech.lastError = 'speech failed';
    runtime.diagnostics.recentErrors = Array.from({ length: 5 }, (_, index) => ({
      id: `error-${index}`,
      category: 'bridge',
      level: 'error' as const,
      summary: index === 1 ? 'duplicate' : `error ${index}`,
      detail: index === 0 ? 'details' : null,
      emittedAt: 'test',
      source: null,
      elapsedMs: null,
    }));
    const alternateAudio = structuredClone(audio);
    alternateAudio.inbound.recommendedAction = null;
    alternateAudio.outbound.recommendedAction = 'restart-output';
    expect(diagnosticsPageHelpers.buildOverviewIssues(runtime, alternateAudio, readySummary)).toContainEqual(
      expect.objectContaining({ id: 'audio-runtime', detail: 'input failed · output failed [建议: restart-output] · speech failed' }),
    );
    const failedSummary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(runtime, audio);
    expect(diagnosticsPageHelpers.buildOverviewIssues(runtime, audio, failedSummary)).toMatchObject([
      { id: 'runtime-live-action-needed' },
      { id: 'bridge-runtime', detail: '已损坏 · bridge.session-mismatch' },
      { id: 'audio-runtime', detail: 'input failed [建议: restart-bridge] · output failed · speech failed' },
      { id: 'error-0', detail: '错误详情：details' },
      { id: 'error-1', detail: '错误分类：bridge' },
    ]);
    expect(diagnosticsPageHelpers.buildOverviewSignals(runtime, audio, failedSummary, 'live-action-needed')[3]).toMatchObject({
      value: '3 条需关注',
      meta: '需排查',
      tone: 'warning',
    });

    const preview = structuredClone(runtimeSnapshotMock);
    preview.diagnostics.recentErrors = [{
      id: 'duplicate-preview',
      category: 'runtime',
      level: 'error',
      summary: '浏览器预览态',
      detail: null,
      emittedAt: 'test',
      source: null,
      elapsedMs: null,
    }];
    const previewSummary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(preview, audio);
    expect(diagnosticsPageHelpers.buildOverviewIssues(preview, audio, previewSummary)[0]).toMatchObject({
      id: 'runtime-browser-preview',
      tone: 'warning',
    });

    const speechOnly = structuredClone(runtimeSnapshotMock);
    const speechAudio = structuredClone(audioRuntimeSnapshotMock);
    speechOnly.bridgeStatus = 'tauri-shell';
    speechOnly.bridge.driverHealth = 'running';
    speechOnly.bridge.lifecycleState = 'ready';
    speechOnly.bridge.lastErrorCode = null;
    speechOnly.diagnostics.recentErrors = [];
    speechAudio.inbound.lastError = null;
    speechAudio.outbound.lastError = null;
    speechAudio.speech.lastError = 'speech only';
    const speechSummary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(speechOnly, speechAudio);
    expect(diagnosticsPageHelpers.buildOverviewIssues(speechOnly, speechAudio, speechSummary)).toMatchObject([
      { id: 'runtime-live-action-needed' },
      { id: 'audio-runtime', detail: 'speech only' },
    ]);

    const duplicateRuntime = structuredClone(runtime);
    duplicateRuntime.diagnostics.recentErrors = [{
      id: 'duplicate-runtime',
      category: 'runtime',
      level: 'error',
      summary: failedSummary.label,
      detail: null,
      emittedAt: 'test',
      source: null,
      elapsedMs: null,
    }];
    const duplicateIssues = diagnosticsPageHelpers.buildOverviewIssues(duplicateRuntime, audio, failedSummary);
    expect(duplicateIssues.filter((issue) => issue.title === failedSummary.label)).toHaveLength(1);
    expect(duplicateIssues.find((issue) => issue.title === failedSummary.label)?.tone).toBe('warning');
  });

  it('builds service monitor badges for pending, running and failed states', () => {
    const runtime = structuredClone(runtimeSnapshotMock);
    const audio = structuredClone(audioRuntimeSnapshotMock);
    const config = structuredClone(appConfigDraftMock);
    runtime.bridgeStatus = 'tauri-shell';
    runtime.bridge.driverHealth = 'running';
    runtime.bridge.bridgeState = 'stopped';
    runtime.bridge.lifecycleState = 'idle';
    runtime.windows = [];
    audio.inbound.streamBound = false;
    audio.inbound.lastError = null;
    audio.outbound.streamBound = false;
    audio.outbound.lastError = null;
    audio.speech.lastError = null;
    config.speech.enabled = false;
    const summary = diagnosticsPageHelpers.getRuntimeEnvironmentSummary(runtime, audio);
    expect(diagnosticsPageHelpers.buildServiceMonitorItems(runtime, audio, config, summary).map((item) => item.tone))
      .toEqual(['ready', 'pending', 'pending', 'pending', 'pending']);

    runtime.bridge.bridgeState = 'running';
    runtime.windows = [{ label: 'subtitle-overlay', visible: true }] as never;
    audio.inbound.streamBound = true;
    audio.outbound.streamBound = true;
    config.speech.enabled = true;
    expect(diagnosticsPageHelpers.buildServiceMonitorItems(runtime, audio, config, summary).map((item) => item.tone))
      .toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);

    runtime.bridge.driverHealth = 'damaged';
    audio.inbound.lastError = 'input';
    audio.outbound.lastError = 'output';
    audio.speech.lastError = 'speech';
    expect(diagnosticsPageHelpers.buildServiceMonitorItems(runtime, audio, config, summary).map((item) => item.tone))
      .toEqual(['ready', 'warning', 'warning', 'warning', 'warning']);
  });
});
