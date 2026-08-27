// Split from DiagnosticsPage.helpers.test.ts: LiveSessionEventDetail rendering
// states, live-event/benchmark text export formatting and the browser download
// adapter. Shared fixtures live in ../test-utils/diagnostics-page-fixtures.
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { benchmarkReport, liveEvents, renderLiveDetail } from '../test-utils/diagnostics-page-fixtures';
import { diagnosticsPageHelpers } from './DiagnosticsPage';
import { DiagnosticsReportExporter, exportJson } from './diagnostics/DiagnosticsDetails';

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
    const html = renderLiveDetail();
    expect(html).toContain('暂无事件数据');
  });

  it('renders ASR event table with newest events first', () => {
    const html = renderLiveDetail({
      sessionStartedAt: 'unix-ms:2000',
      elapsedMs: 8000,
      model: 'asr-model',
      asrDeltas: [
        { elapsedMs: 100, stash: 'first-stash', text: 'first-text', eventType: 'asr.delta' },
        { elapsedMs: 200, stash: '', text: 'second-text', eventType: 'asr.completed' },
      ],
      asrFinal: 'second-text',
    });
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
    const html = renderLiveDetail({
      sessionStartedAt: 'unix-ms:3000',
      elapsedMs: 10000,
      model: 'output-model',
      outputDeltas: [
        { elapsedMs: 300, eventType: 'response.audio_transcript.delta', stash: 'Hello', committedText: '' },
        { elapsedMs: 500, eventType: 'response.done', stash: '', committedText: 'Hello world' },
      ],
      translationFinal: 'Hello world',
    });
    expect(html).toContain('输出事件明细');
    expect(html).toContain('Hello');
    expect(html).toContain('Hello world');
    expect(html).toContain('response.audio_transcript.delta');
    expect(html).toContain('response.done');
  });

  it('renders both ASR and output tables when both have data', () => {
    const html = renderLiveDetail({
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
    });
    expect(html).toContain('ASR 事件明细');
    expect(html).toContain('输出事件明细');
    expect(html).toContain('t1');
    expect(html).toContain('oc1');
  });

  it('formats complete live-event and benchmark text exports', () => {
    const liveText = diagnosticsPageHelpers.formatLiveEventsTxt(liveEvents({
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
    }));
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
    expect(benchmarkText).toContain('Public Benchmark Score');
    expect(benchmarkText).toContain('benchmark-score/v2');
    expect(benchmarkText).toContain('Raw Benchmark Report JSON');
    expect(benchmarkText).toContain('BenchmarkScoreV2 JSON');
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
    vi.useFakeTimers();
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const report = benchmarkReport();
    const events = liveEvents({ sessionStartedAt: 'unix-ms:1', elapsedMs: 2, model: 'model' });

    exportJson({ ok: true }, 'diagnostics.json');
    DiagnosticsReportExporter.exportBenchmark(report, 'benchmark', 'json');
    DiagnosticsReportExporter.exportBenchmark(report, 'benchmark', 'txt');
    DiagnosticsReportExporter.exportLiveEvents(events, 'events', 'json');
    DiagnosticsReportExporter.exportLiveEvents(events, 'events', 'txt');
    vi.runAllTimers();

    expect(createObjectUrl).toHaveBeenCalledTimes(5);
    expect(click).toHaveBeenCalledTimes(5);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});
