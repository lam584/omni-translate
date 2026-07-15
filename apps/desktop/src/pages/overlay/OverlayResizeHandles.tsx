import type { PointerEvent as ReactPointerEvent } from 'react';
import { OVERLAY_RESIZE_HANDLES, type OverlayResizeDirection } from './overlayDomain';

type Props = {
  visible: boolean;
  onPointerDown: (direction: OverlayResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerFinish: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

export default function OverlayResizeHandles(props: Props) {
  if (!props.visible) return null;
  return <>{OVERLAY_RESIZE_HANDLES.map(({ className, direction }) => <div
    aria-label={`resize-${direction.toLowerCase()}`}
    className={`subtitle-overlay-resize-handle ${className}`}
    key={direction}
    onPointerCancel={props.onPointerFinish}
    onPointerDown={(event) => props.onPointerDown(direction, event)}
    onPointerMove={props.onPointerMove}
    onPointerUp={props.onPointerFinish}
    role="presentation"
  />)}</>;
}
