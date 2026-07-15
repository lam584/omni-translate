import type { CSSProperties } from 'react';
import type { SubtitleCueRuntime } from '../../schema/audio-runtime';
import {
  getCueDisplaySegments,
  MIN_SUBTITLE_FONT_SCALE,
  TRANSLATION_FONT_SCALE,
} from './overlayDomain';

type Props = {
  cardStyle: CSSProperties;
  displayCues: SubtitleCueRuntime[];
  displaySegmentCount: number;
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
  return <div className={props.windowSized ? 'subtitle-overlay-lyrics subtitle-overlay-lyrics-window-sized' : 'subtitle-overlay-lyrics'} style={props.cardStyle}>
    {props.showLockToggle ? <button className="subtitle-overlay-toggle-lock" onBlur={props.onLockBlur} onClick={props.onLockToggle} onMouseEnter={() => props.onLockHover(true)} onMouseLeave={() => props.onLockHover(false)} onMouseDown={(event) => event.stopPropagation()} type="button">{props.lockLabel}</button> : null}
    {props.displayCues.length ? <div className="subtitle-overlay-cues">{props.displayCues.map((cue, cueIndex) => {
      const cueScale = props.displayCues.length > 1 ? 0.72 + 0.28 * (cueIndex / (props.displayCues.length - 1)) : 1;
      const densityScale = Math.max(MIN_SUBTITLE_FONT_SCALE, 1 - Math.max(0, props.displaySegmentCount - 4) * 0.04);
      const fontScale = Math.max(MIN_SUBTITLE_FONT_SCALE, cueScale * densityScale);
      const sourceFontSize = `${Math.round(props.effectiveFontSize * fontScale)}px`;
      const translationFontSize = `${Math.round(props.effectiveFontSize * TRANSLATION_FONT_SCALE * fontScale)}px`;
      return <div className="subtitle-overlay-cue" key={cue.cueId}>{getCueDisplaySegments(cue).map((segment) => <div className={segment.pending ? 'subtitle-overlay-segment subtitle-overlay-segment-pending' : 'subtitle-overlay-segment'} key={segment.id}>{segment.sourceText ? <p className="subtitle-overlay-source" style={{ fontSize: sourceFontSize }}>{segment.sourceText}</p> : null}<p className="subtitle-overlay-translation" style={{ fontSize: translationFontSize }}>{segment.translatedText || '\u00a0'}</p></div>)}</div>;
    })}</div> : <><h1 className="subtitle-overlay-source" style={{ fontSize: `${props.effectiveFontSize}px` }}>{props.previewSource}</h1><h1 className="subtitle-overlay-translation" style={{ fontSize: `${Math.round(props.effectiveFontSize * TRANSLATION_FONT_SCALE)}px` }}>{props.previewTranslation}</h1></>}
  </div>;
}
