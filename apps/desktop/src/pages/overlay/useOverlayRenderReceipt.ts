import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { OverlayRenderReceiptRuntime, SubtitleCueRuntime } from '../../schema/audio-runtime';
import type { DesktopApi } from '../../runtime/desktop-api';
import { createLogger } from '../../runtime/logger';
import { getCueDisplaySegments } from './overlayDomain';

const overlayLogger = createLogger('runtime');

export type OverlayRenderModel = {
  cueId: string;
  sourceText: string;
  translatedText: string;
  committed: boolean;
};

export function buildOverlayRenderModels(cues: SubtitleCueRuntime[]): OverlayRenderModel[] {
  return cues.flatMap((cue) => {
    const segments = getCueDisplaySegments(cue);
    const sourceText = segments
      .map((segment) => segment.sourceText.trim())
      .filter(Boolean)
      .join('\n');
    const translatedText = segments
      .map((segment) => segment.translatedText.trim())
      .filter(Boolean)
      .join('\n');
    if (!sourceText && !translatedText) return [];
    return [{
      cueId: cue.cueId,
      sourceText,
      translatedText,
      committed:
        cue.translationCommitted === true
        || (cue.committed && segments.every((segment) => !segment.pending)),
    }];
  });
}

function rendererUnixMs(): number {
  if (typeof performance !== 'undefined'
      && Number.isFinite(performance.timeOrigin)
      && Number.isFinite(performance.now())) {
    return Math.round(performance.timeOrigin + performance.now());
  }
  return Date.now();
}

function contentSignature(model: OverlayRenderModel): string {
  return JSON.stringify([
    model.cueId,
    model.sourceText,
    model.translatedText,
    model.committed,
  ]);
}

type Options = {
  desktopApi: DesktopApi;
  displayCues: SubtitleCueRuntime[];
  reportSessionId: string | null;
};

type ObservedRenderModel = {
  key: string;
  model: OverlayRenderModel;
  revision: number;
  signature: string;
};

type RenderBatch = {
  sessionId: string;
  models: ObservedRenderModel[];
  signature: string;
};

type PendingConfirmation = {
  sessionId: string;
  cancelled: boolean;
  frameId: number;
  previousFrameSignature: string | null;
  readySignature: string | null;
  nativeVisibilityResolved: boolean;
  nativeVisible: boolean;
  requestFrame: () => void;
};

/**
 * Confirms what the overlay actually rendered. A visible receipt is emitted
 * only after React's layout commit and after the same content spans two
 * animation-frame callbacks, guaranteeing that at least one browser render
 * frame was crossed. Rapid model deltas share one frame chain: a change
 * between callbacks extends that chain by one frame instead of restarting it.
 * Hidden updates are acknowledged as `visible=false`; they never become
 * latency samples.
 */
export function useOverlayRenderReceipt({
  desktopApi,
  displayCues,
  reportSessionId,
}: Options): void {
  const models = useMemo(() => buildOverlayRenderModels(displayCues), [displayCues]);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const observedSignatureRef = useRef(new Map<string, string>());
  const revisionRef = useRef(new Map<string, number>());
  const sentSignatureRef = useRef(new Map<string, string>());
  const sessionRef = useRef<string | null>(null);
  const latestBatchRef = useRef<RenderBatch | null>(null);
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  const desktopApiRef = useRef(desktopApi);

  useEffect(() => {
    const notify = () => setVisibilityEpoch((value) => value + 1);
    document.addEventListener('visibilitychange', notify);
    window.addEventListener('focus', notify);
    window.addEventListener('pageshow', notify);
    return () => {
      document.removeEventListener('visibilitychange', notify);
      window.removeEventListener('focus', notify);
      window.removeEventListener('pageshow', notify);
    };
  }, []);

  useEffect(() => {
    if (!reportSessionId || !models.length || !desktopApi.capabilities.hasNativeShell) {
      return undefined;
    }
    let disposed = false;
    let lastVisible: boolean | null = null;
    const check = async () => {
      const visible = document.visibilityState !== 'hidden'
        && await desktopApi.window.isVisible().catch(() => false);
      if (!disposed && lastVisible !== null && visible !== lastVisible) {
        setVisibilityEpoch((value) => value + 1);
      }
      lastVisible = visible;
    };
    const checkVisibility = () => {
      void check().catch((error) => {
        overlayLogger.warn('overlay visibility poll failed', String(error));
      });
    };
    checkVisibility();
    const timer = window.setInterval(checkVisibility, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [desktopApi, models.length, reportSessionId]);

  useLayoutEffect(() => {
    desktopApiRef.current = desktopApi;

    const cancelPendingConfirmation = () => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      pending.cancelled = true;
      if (pending.frameId) window.cancelAnimationFrame(pending.frameId);
      pendingConfirmationRef.current = null;
    };

    if (sessionRef.current !== reportSessionId) {
      cancelPendingConfirmation();
      sessionRef.current = reportSessionId;
      latestBatchRef.current = null;
      observedSignatureRef.current.clear();
      revisionRef.current.clear();
      sentSignatureRef.current.clear();
    }

    if (!reportSessionId || !models.length || !desktopApi.capabilities.hasNativeShell) {
      cancelPendingConfirmation();
      latestBatchRef.current = null;
      return;
    }

    const observedModels = models.map((model): ObservedRenderModel => {
      const key = `${reportSessionId}:${model.cueId}`;
      const signature = contentSignature(model);
      if (observedSignatureRef.current.get(key) !== signature) {
        observedSignatureRef.current.set(key, signature);
        revisionRef.current.set(key, (revisionRef.current.get(key) ?? 0) + 1);
      }
      return {
        key,
        model,
        revision: revisionRef.current.get(key) ?? 1,
        signature,
      };
    });
    const batch: RenderBatch = {
      sessionId: reportSessionId,
      models: observedModels,
      signature: JSON.stringify(observedModels.map((model) => [
        model.key,
        model.signature,
        model.revision,
      ])),
    };
    latestBatchRef.current = batch;

    const emitBatch = (confirmedBatch: RenderBatch, visible: boolean) => {
      if (sessionRef.current !== confirmedBatch.sessionId) return;
      for (const observed of confirmedBatch.models) {
        const receiptSignature = `${observed.signature}:${visible ? 'visible' : 'hidden'}`;
        if (sentSignatureRef.current.get(observed.key) === receiptSignature) continue;

        const receipt: OverlayRenderReceiptRuntime = {
          sessionId: confirmedBatch.sessionId,
          cueId: observed.model.cueId,
          revision: observed.revision,
          sourceText: observed.model.sourceText,
          translatedText: observed.model.translatedText,
          committed: observed.model.committed,
          visible,
          renderedAtMs: rendererUnixMs(),
        };
        // Rendering must never wait on diagnostics. Mark the signature before
        // sending, and intentionally swallow transport failures.
        sentSignatureRef.current.set(observed.key, receiptSignature);
        void desktopApiRef.current.overlay.rendered(receipt).catch(() => undefined);
      }
    };

    if (document.visibilityState === 'hidden') {
      cancelPendingConfirmation();
      emitBatch(batch, false);
      return;
    }

    const existing = pendingConfirmationRef.current;
    if (existing?.sessionId === reportSessionId && !existing.cancelled) {
      if (!existing.frameId && existing.readySignature !== batch.signature) {
        existing.readySignature = null;
        existing.requestFrame();
      }
      return;
    }

    const pending: PendingConfirmation = {
      sessionId: reportSessionId,
      cancelled: false,
      frameId: 0,
      previousFrameSignature: null,
      readySignature: null,
      nativeVisibilityResolved: false,
      nativeVisible: false,
      requestFrame: () => undefined,
    };
    pendingConfirmationRef.current = pending;

    const finish = () => {
      if (pendingConfirmationRef.current !== pending || pending.cancelled) return;
      const latest = latestBatchRef.current;
      if (!latest || latest.sessionId !== pending.sessionId) return;

      if (document.visibilityState === 'hidden' || (pending.nativeVisibilityResolved && !pending.nativeVisible)) {
        pending.cancelled = true;
        if (pending.frameId) window.cancelAnimationFrame(pending.frameId);
        pendingConfirmationRef.current = null;
        emitBatch(latest, false);
        return;
      }
      if (!pending.nativeVisibilityResolved || !pending.readySignature) return;
      if (pending.readySignature !== latest.signature) {
        pending.readySignature = null;
        pending.requestFrame();
        return;
      }

      pending.cancelled = true;
      pendingConfirmationRef.current = null;
      emitBatch(latest, true);
    };

    const onFrame = () => {
      pending.frameId = 0;
      if (pendingConfirmationRef.current !== pending || pending.cancelled) return;
      const latest = latestBatchRef.current;
      if (!latest || latest.sessionId !== pending.sessionId) return;

      if (pending.previousFrameSignature === latest.signature) {
        pending.readySignature = latest.signature;
        finish();
        return;
      }
      pending.previousFrameSignature = latest.signature;
      pending.requestFrame();
    };
    pending.requestFrame = () => {
      if (pending.cancelled || pending.frameId) return;
      pending.frameId = window.requestAnimationFrame(onFrame);
    };

    // Query native visibility and cross the render frame concurrently. A slow
    // IPC response therefore cannot postpone the browser-side confirmation.
    void desktopApi.window.isVisible()
      .catch(() => false)
      .then((visible) => {
        if (pendingConfirmationRef.current !== pending || pending.cancelled) return;
        pending.nativeVisibilityResolved = true;
        pending.nativeVisible = visible;
        finish();
      });
    pending.requestFrame();
  }, [desktopApi, models, reportSessionId, visibilityEpoch]);

  useEffect(() => () => {
    const pending = pendingConfirmationRef.current;
    if (!pending) return;
    pending.cancelled = true;
    if (pending.frameId) window.cancelAnimationFrame(pending.frameId);
    pendingConfirmationRef.current = null;
  }, []);
}
