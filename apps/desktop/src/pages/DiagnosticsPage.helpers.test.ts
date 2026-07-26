import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { BenchmarkReport, BenchmarkRunResult } from '../runtime/benchmark-runtime';
import { diagnosticsPageHelpers } from './DiagnosticsPage';
import { DiagnosticsReportExporter, exportJson } from './diagnostics/DiagnosticsDetails';

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
    expect(diagnosticsPageHelpers.buildOverviewIssues(runtime, alternateAudio, readySummary)[0]).toBeTruthy();
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

  it('covers benchmark event helpers and default report shape', () => {
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.audio.delta')).toBe(true);
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.output_audio.done')).toBe(true);
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.text.delta')).toBe(false);
    expect(diagnosticsPageHelpers.isTextOutputEvent('response.text.delta')).toBe(true);
    expect(diagnosticsPageHelpers.isTextOutputEvent('response.audio.done')).toBe(false);

    expect(diagnosticsPageHelpers.shouldUseManualBenchmarkMode('qwen3.5-omni-plus-realtime')).toBe(true);
    expect(diagnosticsPageHelpers.shouldUseManualBenchmarkMode('qwen-livetranslate-realtime')).toBe(false);
    expect(diagnosticsPageHelpers.textLength('a好')).toBe(2);
    expect(diagnosticsPageHelpers.shouldUseCandidate('', '')).toBe(false);
    expect(diagnosticsPageHelpers.shouldUseCandidate('abc', 'ab')).toBe(false);
    expect(diagnosticsPageHelpers.shouldUseCandidate('abc', 'abcd')).toBe(true);

    expect(diagnosticsPageHelpers.createEmptyBenchmarkReport('plain-model', 'sample.mp3')).toMatchObject({
      model: 'plain-model',
      realtimeAudioMode: 'manual',
      interactionCapabilities: [],
      audioFile: 'sample.mp3',
      audioDurationSecs: 0,
      runs: [],
      summary: {
        runCount: 0,
        successfulRuns: 0,
      },
    });
    expect(diagnosticsPageHelpers.createEmptyBenchmarkReport('liveTranslate-model', 'sample.mp3', ['push_to_talk'])).toMatchObject({
      realtimeAudioMode: 'server_vad',
      interactionCapabilities: ['push_to_talk'],
    });
  });

  it('builds benchmark output segments from delta, transcript, done and fallback events', () => {
    expect(diagnosticsPageHelpers.buildOutputSegments([
      { elapsedMs: 10, eventType: 'response.text.delta', stash: '你', committedText: '', rawText: '' },
      { elapsedMs: 20, eventType: 'response.text.delta', stash: '好', committedText: '', rawText: '' },
      { elapsedMs: 30, eventType: 'response.audio_transcript.text', stash: '', committedText: '', rawText: '你好世界' },
      { elapsedMs: 40, eventType: 'response.done', stash: '', committedText: '', rawText: '' },
      { elapsedMs: 50, eventType: 'response.output_item.done', stash: '完成', committedText: '', rawText: '' },
      { elapsedMs: 60, eventType: 'response.custom', stash: '', committedText: '兜底', rawText: '' },
    ])).toEqual(['你好世界', '完成', '兜底']);

    expect(diagnosticsPageHelpers.buildOutputSegments([
      { elapsedMs: 10, eventType: 'response.text.delta', stash: '短', committedText: '', rawText: '' },
      { elapsedMs: 20, eventType: 'response.audio_transcript.text', stash: '', committedText: '', rawText: '长文本' },
      { elapsedMs: 30, eventType: 'response.text.done', stash: '完结文本', committedText: '', rawText: '' },
      { elapsedMs: 40, eventType: 'response.text.delta', stash: '尾巴', committedText: '', rawText: '' },
    ])).toEqual(['完结文本', '尾巴']);
  });

  it('renders benchmark progress and empty detail states', () => {
    expect(renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, { error: null, progress: null }))).toBe('');

    const running = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, {
      error: null,
      progress: {
        status: 'running',
        phase: 'sending',
        message: '',
        audioChunksSent: 3,
        totalAudioChunks: 6,
        error: null,
      },
    }));
    expect(running).toContain('benchmark-progress-running');
    expect(running).toContain('50%');
    expect(running).toContain('3 / 6 chunks');

    const completed = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, {
      error: null,
      progress: {
        status: 'completed',
        phase: 'done',
        message: 'completed',
        audioChunksSent: 0,
        totalAudioChunks: 0,
        error: null,
      },
    }));
    expect(completed).toContain('benchmark-progress-completed');

    const failed = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, {
      error: 'boom',
      progress: {
        status: 'running',
        phase: 'failed',
        message: 'ignored',
        audioChunksSent: 0,
        totalAudioChunks: 0,
        error: 'boom',
      },
    }));
    expect(failed).toContain('benchmark-progress-error');
    expect(failed).toContain('boom');

    const emptyReport = diagnosticsPageHelpers.createEmptyBenchmarkReport('model', 'sample.mp3');
    expect(renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report: emptyReport }))).toContain('benchmark-empty');
  });

  it('renders benchmark detail warning, timing and table branches', () => {
    const report = benchmarkReport({
      realtimeAudioMode: 'server_vad',
      run: {
        model: 'liveTranslate-model',
        audioDurationSecs: 30,
        audioSendMs: 3000,
        responseCreatedMs: 900,
        firstOutputMs: 700,
        responseDoneMs: 1200,
        responseDoneAudioChunksSent: 2,
        responseDoneAudioSentSecs: 1,
        speechStartedMs: 100,
        speechStoppedMs: 800,
        firstAsrMs: 150,
        asrFinal: 'asr text',
        asrDeltas: [{ elapsedMs: 100, stash: '', text: 'asr text' }],
        outputDeltas: [
          { elapsedMs: 700, eventType: 'response.text.delta', stash: 'hello', committedText: '', rawText: '' },
          { elapsedMs: 900, eventType: 'response.text.done', stash: '', committedText: 'hello world', rawText: '' },
        ],
        translationFinal: '',
        responseCount: 1,
        totalOutputDurationMs: null,
      },
    });

    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report }));
    expect(html).toContain('benchmark-warning');
    expect(html).toContain('benchmark-timeline-marker');
    expect(html).toContain('benchmark-delta-table');
    expect(html).toContain('hello world');
    expect(html).toContain('asr text');
  });

  it('renders benchmark detail transcript-only and fallback output branches', () => {
    const transcriptOnly = benchmarkReport({
      realtimeAudioMode: 'manual',
      run: {
        firstOutputMs: null,
        responseCreatedMs: null,
        responseDoneMs: 500,
        responseDoneAudioSentSecs: null,
        responseDoneAudioChunksSent: null,
        outputDeltas: [],
        translationFinal: '',
        asrFinal: 'transcript only',
        asrDeltas: [{ elapsedMs: 50, stash: '', text: '' }],
      },
    });
    const transcriptHtml = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report: transcriptOnly }));
    expect(transcriptHtml).toContain('transcript only');
    expect(transcriptHtml).toContain('N/A');
    expect(transcriptHtml).toContain('benchmark-warning');

    const fallbackOutput = benchmarkReport({
      realtimeAudioMode: undefined,
      run: {
        model: 'plain-model',
        responseDoneMs: 500,
        responseCreatedMs: 100,
        firstOutputMs: null,
        outputDeltas: [
          { elapsedMs: 200, eventType: 'response.custom', stash: '', committedText: '', rawText: 'fallback raw' },
        ],
        translationFinal: '',
        asrFinal: '',
      },
    });
    const fallbackHtml = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report: fallbackOutput }));
    expect(fallbackHtml).toContain('fallback raw');
    expect(fallbackHtml).toContain('benchmark-delta-table');
  });

  it('renders benchmark progress fallbacks and clamps chunk progress', () => {
    const defaultProgress = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, {
      error: null,
      progress: {
        status: undefined as never,
        phase: undefined as never,
        message: '',
        audioChunksSent: undefined as never,
        totalAudioChunks: undefined as never,
        error: null,
      },
    }));
    expect(defaultProgress).toContain('benchmark-progress-running');
    expect(defaultProgress).toContain('starting');
    expect(defaultProgress).toContain('0%');

    const overSent = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkProgressBanner, {
      error: null,
      progress: {
        status: 'running',
        phase: 'sending',
        message: 'over sent',
        audioChunksSent: 12,
        totalAudioChunks: 6,
        error: null,
      },
    }));
    expect(overSent).toContain('100%');
    expect(overSent).toContain('12 / 6 chunks');
  });

  it('renders benchmark detail negative timing, chunk percent fallback and waiting output', () => {
    const report = benchmarkReport({
      realtimeAudioMode: 'server_vad',
      run: {
        model: 'liveTranslate-model',
        audioDurationSecs: 0,
        audioSendMs: 0,
        responseCreatedMs: 500,
        firstOutputMs: 250,
        responseDoneMs: 700,
        responseDoneAudioSentSecs: 1,
        responseDoneAudioChunksSent: 4,
        outputDeltas: [
          { elapsedMs: 250, eventType: 'response.text.delta', stash: '', committedText: '', rawText: '' },
        ],
        translationFinal: '',
        asrFinal: '',
        responseCount: 0,
      },
    });

    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report }));
    expect(html).toContain('N/A%');
    expect(html).toContain('4 chunks');
    expect(html).toContain('benchmark-translation');
    expect(html).toContain('benchmark-delta-table');
    expect(html).toContain('250.0ms');
  });

  it('renders benchmark detail with no text output table and server-vad fallback mode', () => {
    const report = benchmarkReport({
      realtimeAudioMode: undefined,
      run: {
        model: 'liveTranslate-model',
        audioDurationSecs: 3,
        audioSendMs: 3000,
        responseCreatedMs: 100,
        firstOutputMs: null,
        responseDoneMs: null,
        outputDeltas: [],
        translationFinal: '',
        asrFinal: '',
        responseCount: 0,
      },
    });

    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report }));
    expect(html).toContain('benchmark-translation');
    expect(html).toContain('N/A');
    expect(html).not.toContain('benchmark-delta-table');
  });

  it('chooses benchmark output candidates across transcript and final events', () => {
    expect(diagnosticsPageHelpers.buildOutputSegments([
      { elapsedMs: 10, eventType: 'response.text.delta', stash: 'short', committedText: '', rawText: '' },
      { elapsedMs: 20, eventType: 'response.audio_transcript.text', stash: '', committedText: '', rawText: 'tiny' },
      { elapsedMs: 30, eventType: 'response.done', stash: '', committedText: '', rawText: '' },
      { elapsedMs: 40, eventType: 'response.text.delta', stash: 'next', committedText: '', rawText: '' },
      { elapsedMs: 50, eventType: 'response.text.done', stash: '', committedText: '', rawText: 'longer-final' },
      { elapsedMs: 60, eventType: 'response.custom', stash: '', committedText: '', rawText: 'short' },
      { elapsedMs: 70, eventType: 'response.custom', stash: '', committedText: 'longer-custom', rawText: '' },
    ])).toEqual(['short', 'longer-final', 'longer-custom']);
  });
});

describe('LiveSessionEventDetail', () => {
  it('renders empty state when events are null', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, { events: null, loading: false }));
    expect(html).toContain('暂无事件数据');
  });

  it('renders loading state when loading with no events', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, { events: null, loading: true }));
    expect(html).toContain('正在加载');
  });

  it('renders empty state when events have no deltas', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, {
      events: {
        sessionStartedAt: 'unix-ms:1000',
        elapsedMs: 5000,
        model: 'test-model',
        asrDeltas: [],
        outputDeltas: [],
        asrFinal: '',
        translationFinal: '',
        pipelineMilestones: { preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null, firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null, droppedBeforeReady: null, firstAudibleChunkMs: null, silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null }
      },
      loading: false,
    }));
    expect(html).toContain('暂无事件数据');
  });

  it('renders ASR event table with newest events first', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, {
      events: {
        sessionStartedAt: 'unix-ms:2000',
        elapsedMs: 8000,
        model: 'asr-model',
        asrDeltas: [
          { elapsedMs: 100, stash: 'first-stash', text: 'first-text', eventType: 'asr.delta' },
          { elapsedMs: 200, stash: '', text: 'second-text', eventType: 'asr.completed' },
        ],
        outputDeltas: [],
        asrFinal: 'second-text',
        translationFinal: '',
        pipelineMilestones: { preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null, firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null, droppedBeforeReady: null, firstAudibleChunkMs: null, silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null }
      },
      loading: false,
    }));
    expect(html).toContain('ASR 事件明细');
    expect(html).toContain('first-stash');
    expect(html).toContain('second-text');
    expect(html).toContain('asr.delta');
    expect(html).toContain('asr.completed');
    // Newest first: row 2 should appear before row 1
    const idx2pos = html.indexOf('>2<');
    const idx1pos = html.indexOf('>1<');
    expect(idx2pos).toBeLessThan(idx1pos);
  });

  it('renders output event table with committed text', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, {
      events: {
        sessionStartedAt: 'unix-ms:3000',
        elapsedMs: 10000,
        model: 'output-model',
        asrDeltas: [],
        outputDeltas: [
          { elapsedMs: 300, eventType: 'response.audio_transcript.delta', stash: 'Hello', committedText: '' },
          { elapsedMs: 500, eventType: 'response.done', stash: '', committedText: 'Hello world' },
        ],
        asrFinal: '',
        translationFinal: 'Hello world',
        pipelineMilestones: { preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null, firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null, droppedBeforeReady: null, firstAudibleChunkMs: null, silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null }
      },
      loading: false,
    }));
    expect(html).toContain('输出事件明细');
    expect(html).toContain('Hello');
    expect(html).toContain('Hello world');
    expect(html).toContain('response.audio_transcript.delta');
    expect(html).toContain('response.done');
  });

  it('renders both ASR and output tables when both have data', () => {
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, {
      events: {
        sessionStartedAt: 'unix-ms:4000',
        elapsedMs: 12000,
        model: 'both-model',
        asrDeltas: [
          { elapsedMs: 50, stash: 's1', text: 't1', eventType: 'asr' },
        ],
        outputDeltas: [
          { elapsedMs: 100, eventType: 'out', stash: 'os1', committedText: 'oc1' },
        ],
        asrFinal: 't1',
        translationFinal: 'oc1',
        pipelineMilestones: { preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null, firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null, droppedBeforeReady: null, firstAudibleChunkMs: null, silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null }
      },
      loading: false,
    }));
    expect(html).toContain('ASR 事件明细');
    expect(html).toContain('输出事件明细');
    expect(html).toContain('t1');
    expect(html).toContain('oc1');
  });

  it('formats complete live-event and benchmark text exports', () => {
    const liveText = diagnosticsPageHelpers.formatLiveEventsTxt({
      sessionStartedAt: 'unix-ms:4000',
      elapsedMs: 12000,
      model: 'export-model',
      asrDeltas: [{ elapsedMs: 50, stash: 'asr-stash', text: 'source', eventType: 'asr.delta' }],
      outputDeltas: [{ elapsedMs: 100, eventType: 'output.delta', stash: 'out-stash', committedText: 'translated' }],
      asrFinal: 'source final',
      translationFinal: 'translation final',
      pipelineMilestones: {
        preconnectStartedMs: 10,
        sessionReadyMs: 20,
        routeStartedMs: 30,
        firstAudioSentMs: 40,
        firstSpeechStartedMs: 80,
        queuedAudioChunks: 3,
        droppedBeforeReady: 1,
        firstAudibleChunkMs: 60,
        silenceSkippedBeforeAudible: 2,
        totalInputChunksAtSpeech: 4,
      },
    });
    expect(liveText).toContain('Audio Sent -> Audible:     20ms');
    expect(liveText).toContain('Audible -> VAD Speech:     20ms');
    expect(liveText).toContain('source final');
    expect(liveText).toContain('translation final');
    expect(diagnosticsPageHelpers.fmtMs(null)).toBe('N/A');

    const report = benchmarkReport({
      run: {
        asrFinal: 'recognized',
        translationFinal: 'translated',
        outputDeltas: [{ elapsedMs: 100, eventType: 'response.text.delta', stash: 'stash', committedText: 'translated', rawText: 'translated' }],
        firstAsrMs: 50,
        firstCommittedMs: 125,
        responseDoneMs: 200,
        speechStartedMs: 60,
        speechStoppedMs: 180,
      },
    });
    const benchmarkText = diagnosticsPageHelpers.formatBenchmarkTxt(report);
    expect(benchmarkText).toContain('Benchmark Report');
    expect(benchmarkText).toContain('ASR Final: recognized');
    expect(benchmarkText).toContain('Translation Final: translated');
    expect(benchmarkText).toContain('response.text.delta');
  });

  it('formats sparse live and benchmark exports with every empty-field fallback', () => {
    expect(diagnosticsPageHelpers.buildOutputSegments([
      { elapsedMs: 1, eventType: 'response.done', stash: '', committedText: '', rawText: '' },
      { elapsedMs: 2, eventType: 'response.audio_transcript.text', stash: 'long candidate', committedText: '', rawText: '' },
      { elapsedMs: 3, eventType: 'other', stash: 'x', committedText: '', rawText: '' },
    ])).toEqual(['long candidate']);

    const live = {
      sessionStartedAt: 'start', elapsedMs: 1, model: 'm',
      asrDeltas: [{ elapsedMs: 1, stash: '', text: '', eventType: 'asr' }],
      outputDeltas: [{ elapsedMs: 2, eventType: 'out', stash: '', committedText: '' }],
      asrFinal: '', translationFinal: '', pipelineMilestones: undefined,
    };
    const liveText = diagnosticsPageHelpers.formatLiveEventsTxt(live as never);
    expect(liveText).toContain('N/A');
    const liveHtml = renderToStaticMarkup(createElement(diagnosticsPageHelpers.LiveSessionEventDetail, { events: live as never, loading: false }));
    expect(liveHtml).toContain('benchmark-delta-table');

    const report = benchmarkReport({ run: {
      asrFinal: '', translationFinal: '', firstAsrMs: null, firstOutputMs: null,
      responseDoneMs: null, speechStartedMs: null, speechStoppedMs: null,
      outputDeltas: [{ elapsedMs: 1, eventType: 'out', stash: '', committedText: '', rawText: '' }],
    } });
    expect(diagnosticsPageHelpers.formatBenchmarkTxt(report)).toContain('N/A');
  });

  it('renders early response diagnostics without the sparse-output hint', () => {
    const report = benchmarkReport({ run: {
      audioDurationSecs: 20, responseDoneAudioSentSecs: 1, responseDoneAudioChunksSent: 1,
      outputDeltas: Array.from({ length: 4 }, (_, index) => ({
        elapsedMs: index + 1, eventType: 'response.text.delta', stash: 'x', committedText: 'x', rawText: 'x',
      })),
    } });
    const html = renderToStaticMarkup(createElement(diagnosticsPageHelpers.BenchmarkReportDetail, { report }));
    expect(html).toContain('benchmark-warning');
  });

  it('exports diagnostic reports through the browser download adapter', () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const report = benchmarkReport();
    const events = {
      sessionStartedAt: 'unix-ms:1', elapsedMs: 2, model: 'model', asrDeltas: [], outputDeltas: [],
      asrFinal: '', translationFinal: '',
      pipelineMilestones: {
        preconnectStartedMs: null, sessionReadyMs: null, routeStartedMs: null,
        firstAudioSentMs: null, firstSpeechStartedMs: null, queuedAudioChunks: null,
        droppedBeforeReady: null, firstAudibleChunkMs: null,
        silenceSkippedBeforeAudible: null, totalInputChunksAtSpeech: null,
      },
    };

    exportJson({ ok: true }, 'diagnostics.json');
    DiagnosticsReportExporter.exportBenchmark(report, 'benchmark', 'json');
    DiagnosticsReportExporter.exportBenchmark(report, 'benchmark', 'txt');
    DiagnosticsReportExporter.exportLiveEvents(events, 'events', 'json');
    DiagnosticsReportExporter.exportLiveEvents(events, 'events', 'txt');

    expect(createObjectUrl).toHaveBeenCalledTimes(5);
    expect(click).toHaveBeenCalledTimes(5);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(5);
  });
});

function benchmarkReport(overrides: {
  realtimeAudioMode?: BenchmarkReport['realtimeAudioMode'];
  run?: Partial<BenchmarkRunResult>;
} = {}): BenchmarkReport {
  const run: BenchmarkRunResult = {
    runIndex: 0,
    model: 'qwen3.5-omni-plus-realtime',
    connectMs: 10,
    sessionReadyMs: 20,
    audioSendMs: 100,
    audioChunksSent: 2,
    audioDurationSecs: 3,
    firstAsrMs: null,
    asrDeltas: [],
    asrFinal: '',
    firstOutputMs: 150,
    firstCommittedMs: null,
    outputDeltas: [],
    translationFinal: '',
    responseCreatedMs: 120,
    responseDoneMs: null,
    responseDoneAudioChunksSent: null,
    responseDoneAudioSentSecs: null,
    responseCount: 0,
    speechStartedMs: null,
    speechStoppedMs: null,
    timeToFirstTokenMs: 150,
    timeToFirstCommittedMs: null,
    totalOutputDurationMs: null,
    outputDeltaCount: 0,
    ...overrides.run,
  };

  return {
    model: run.model,
    realtimeAudioMode: overrides.realtimeAudioMode,
    audioFile: 'sample.mp3',
    audioDurationSecs: run.audioDurationSecs,
    runs: [run],
    summary: {
      runCount: 1,
      successfulRuns: 1,
      avgConnectMs: 10,
      avgSessionReadyMs: 20,
      avgTimeToFirstTokenMs: null,
      avgTimeToFirstCommittedMs: null,
      avgOutputDeltaIntervalMs: null,
      avgOutputDeltasPerRun: run.outputDeltas.length,
      avgTotalOutputDurationMs: null,
      p50DeltaIntervalMs: null,
      p90DeltaIntervalMs: null,
      p99DeltaIntervalMs: null,
      minDeltaIntervalMs: null,
      maxDeltaIntervalMs: null,
    },
  };
}
