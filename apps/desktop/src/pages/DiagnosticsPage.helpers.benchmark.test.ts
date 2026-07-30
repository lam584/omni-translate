// Split from DiagnosticsPage.helpers.test.ts: benchmark event helpers,
// output-segment assembly and BenchmarkProgressBanner/BenchmarkReportDetail
// rendering branches. Shared fixtures live in
// ../test-utils/diagnostics-page-fixtures.
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { benchmarkReport } from '../test-utils/diagnostics-page-fixtures';
import { diagnosticsPageHelpers } from './DiagnosticsPage';

describe('diagnostics page helpers', () => {
  it('covers benchmark event helpers and default report shape', () => {
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.audio.delta')).toBe(true);
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.output_audio.done')).toBe(true);
    expect(diagnosticsPageHelpers.isBinaryAudioOutputEvent('response.text.delta')).toBe(false);
    expect(diagnosticsPageHelpers.isTextOutputEvent('response.text.delta')).toBe(true);
    expect(diagnosticsPageHelpers.isTextOutputEvent('response.audio.done')).toBe(false);

    expect(diagnosticsPageHelpers.textLength('a好')).toBe(2);
    expect(diagnosticsPageHelpers.shouldUseCandidate('', '')).toBe(false);
    expect(diagnosticsPageHelpers.shouldUseCandidate('abc', 'ab')).toBe(false);
    expect(diagnosticsPageHelpers.shouldUseCandidate('abc', 'abcd')).toBe(true);

    expect(diagnosticsPageHelpers.createEmptyBenchmarkReport('plain-model', 'sample.mp3')).toMatchObject({
      model: 'plain-model',
      realtimeAudioMode: 'server_vad',
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
