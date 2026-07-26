import { useCallback, useLayoutEffect, useRef, type CSSProperties, type UIEvent } from 'react';
import type { SubtitleCueRuntime } from '../../schema/audio-runtime';
import {
  getOverlayTimeline,
  MIN_SUBTITLE_FONT_SCALE,
  TRANSLATION_FONT_SCALE,
} from './overlayDomain';

type Props = {
  cardStyle: CSSProperties;
  displayCues: SubtitleCueRuntime[];
  effectiveFontSize: number;
  overlayLocked: boolean;
  showLockToggle: boolean;
  windowSized: boolean;
  lockLabel: string;
  previewSource: string;
  previewTranslation: string;
  onLockBlur: () => void;
  onLockHover: (hovered: boolean) => void;
  onLockToggle: () => void;
};

export default function SubtitleOverlayContent(props: Props) {
  const distinctPreviewSource = props.previewSource.trim() !== props.previewTranslation.trim();
  const cuesRef = useRef<HTMLDivElement | null>(null);
  const followingLatestRef = useRef(true);
  const timeline = getOverlayTimeline(props.displayCues);
  const liveTranslation = timeline.liveSegment?.translatedText.trim() ?? '';
  const liveSource = [timeline.liveSegment?.sourceText.trim(), timeline.liveSourceTail]
    .filter(Boolean)
    .join(' ');
  const streamActive = Boolean(liveSource || liveTranslation);
  const scrollToLatest = useCallback(() => {
    const element = cuesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (followingLatestRef.current) scrollToLatest();
  }, [props.displayCues, scrollToLatest]);

  useLayoutEffect(() => {
    const element = cuesRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (followingLatestRef.current) scrollToLatest();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  const handleCuesScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  }, []);

  return <div className={props.windowSized ? 'subtitle-overlay-lyrics subtitle-overlay-lyrics-window-sized' : 'subtitle-overlay-lyrics'} style={props.cardStyle}>
    {props.showLockToggle ? <button className="subtitle-overlay-toggle-lock" onBlur={props.onLockBlur} onClick={props.onLockToggle} onMouseEnter={() => props.onLockHover(true)} onMouseLeave={() => props.onLockHover(false)} onMouseDown={(event) => event.stopPropagation()} type="button">{props.lockLabel}</button> : null}
    {props.displayCues.length ? <div className="subtitle-overlay-cues">
      <div className="subtitle-overlay-history" onScroll={handleCuesScroll} ref={cuesRef}>{timeline.cues.map(({ cue, historySegments }, cueIndex) => {
        if (!historySegments.length) return null;
        const cueScale = props.displayCues.length > 1 ? 0.72 + 0.28 * (cueIndex / (props.displayCues.length - 1)) : 1;
        const fontScale = Math.max(MIN_SUBTITLE_FONT_SCALE, cueScale);
        const sourceFontSize = `${Math.round(props.effectiveFontSize * fontScale)}px`;
        const translationFontSize = `${Math.round(props.effectiveFontSize * TRANSLATION_FONT_SCALE * fontScale)}px`;
        return <div className="subtitle-overlay-cue" key={cue.cueId}>{historySegments.map((segment) => <div className={segment.pending ? 'subtitle-overlay-segment subtitle-overlay-segment-pending' : 'subtitle-overlay-segment'} key={segment.id}>{segment.sourceText ? <p className="subtitle-overlay-source" style={{ fontSize: sourceFontSize }}>{segment.sourceText}</p> : null}<p className="subtitle-overlay-translation" style={{ fontSize: translationFontSize }}>{segment.translatedText}</p></div>)}</div>;
      })}</div>
      <div className={streamActive ? 'subtitle-overlay-stream-slot subtitle-overlay-stream-slot-active' : 'subtitle-overlay-stream-slot'}>
        <p className="subtitle-overlay-stream-source" style={{ fontSize: `${Math.round(props.effectiveFontSize * MIN_SUBTITLE_FONT_SCALE)}px` }}>{liveSource || '\u00a0'}</p>
        <p className="subtitle-overlay-stream-text" style={{ fontSize: `${Math.round(props.effectiveFontSize * TRANSLATION_FONT_SCALE)}px` }}>{liveTranslation || '\u00a0'}</p>
      </div>
    </div> : <>{distinctPreviewSource ? <h1 className="subtitle-overlay-source" style={{ fontSize: `${props.effectiveFontSize}px` }}>{props.previewSource}</h1> : null}<h1 className="subtitle-overlay-translation" style={{ fontSize: `${Math.round(props.effectiveFontSize * TRANSLATION_FONT_SCALE)}px` }}>{props.previewTranslation}</h1></>}
  </div>;
}
