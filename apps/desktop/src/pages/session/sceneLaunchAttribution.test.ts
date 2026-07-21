import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { DiagnosticLogEntryRuntime } from '../../schema/runtime-core';
import { describeSceneLaunchAttribution } from './sceneLaunchAttribution';

function snapshotWithInbound(patch: Partial<AudioRuntimeSnapshot['inbound']>): AudioRuntimeSnapshot {
  return {
    ...audioRuntimeSnapshotMock,
    inbound: { ...audioRuntimeSnapshotMock.inbound, ...patch },
  };
}

function logEntry(summary: string): DiagnosticLogEntryRuntime {
  return {
    id: `log-${summary}`,
    category: 'audio',
    level: 'info',
    summary,
    detail: null,
    emittedAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('describeSceneLaunchAttribution', () => {
  it('classifies an acknowledged route that never becomes ready (armed forever)', () => {
    const result = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('系统音频采集未在启动期限内就绪。'),
      snapshot: snapshotWithInbound({ captureState: 'armed', streamBound: false, lastError: null }),
      recentLogs: [logEntry('watch_mode.route_start_acknowledged')],
      commandAccepted: true,
    });

    expect(result.outcome).toBe('capture-not-ready');
    expect(result.message).toContain('已接受命令但未在期限内就绪');
    expect(result.message).toContain('armed');
    expect(result.message).toContain('route_start_acknowledged');
  });

  it('classifies a native capture error reported through lastError', () => {
    const result = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('capture unavailable'),
      snapshot: snapshotWithInbound({ captureState: 'buffering', streamBound: false, lastError: '采集设备被占用' }),
      recentLogs: [logEntry('watch_mode.route_error')],
      commandAccepted: true,
    });

    expect(result.outcome).toBe('capture-error');
    expect(result.message).toContain('报错');
    expect(result.message).toContain('采集设备被占用');
  });

  it('classifies a rejected start command that was never acknowledged', () => {
    const result = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('启动音频采集超时：30 秒内未收到 Rust 运行时结果。'),
      snapshot: snapshotWithInbound({ captureState: 'idle', streamBound: false, lastError: null }),
      recentLogs: [],
      commandAccepted: false,
    });

    expect(result.outcome).toBe('command-rejected');
    expect(result.message).toContain('命令未被接受');
  });

  it('produces three distinct attributable messages rather than one shared timeout line', () => {
    const notReady = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('系统音频采集未在启动期限内就绪。'),
      snapshot: snapshotWithInbound({ captureState: 'armed', streamBound: false, lastError: null }),
      recentLogs: [logEntry('watch_mode.route_start_acknowledged')],
      commandAccepted: true,
    });
    const captureError = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('capture unavailable'),
      snapshot: snapshotWithInbound({ captureState: 'buffering', streamBound: false, lastError: '采集设备被占用' }),
      recentLogs: [logEntry('watch_mode.route_error')],
      commandAccepted: true,
    });
    const commandRejected = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('启动音频采集超时'),
      snapshot: snapshotWithInbound({ captureState: 'idle', streamBound: false, lastError: null }),
      recentLogs: [],
      commandAccepted: false,
    });

    const messages = new Set([notReady.message, captureError.message, commandRejected.message]);
    expect(messages.size).toBe(3);
    const outcomes = new Set([notReady.outcome, captureError.outcome, commandRejected.outcome]);
    expect(outcomes.size).toBe(3);
  });

  it('recovers acknowledgement from native markers even when the frontend flag is unset', () => {
    const result = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('启动超过 0.9 秒'),
      snapshot: snapshotWithInbound({ captureState: 'armed', streamBound: false, lastError: null }),
      recentLogs: [logEntry('watch_mode.route_start_acknowledged')],
      commandAccepted: false,
    });

    expect(result.outcome).toBe('capture-not-ready');
  });

  it('degrades gracefully when no native snapshot is available', () => {
    const result = describeSceneLaunchAttribution({
      stage: 'inbound-route',
      error: new Error('启动超过 0.9 秒'),
      snapshot: null,
      recentLogs: [],
      commandAccepted: false,
    });

    expect(result.outcome).toBe('command-rejected');
    expect(result.message).toContain('采集状态未知');
    expect(result.message).toContain('无相关记录');
  });
});
