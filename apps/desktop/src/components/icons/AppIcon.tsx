import type { CSSProperties } from 'react';

export type AppIconName =
  | 'activity'
  | 'alert'
  | 'book'
  | 'check'
  | 'clock'
  | 'close'
  | 'cloud'
  | 'eye'
  | 'eye-off'
  | 'globe'
  | 'headphones'
  | 'key'
  | 'layers'
  | 'lock'
  | 'mic'
  | 'panel'
  | 'play'
  | 'power'
  | 'refresh'
  | 'route'
  | 'search'
  | 'settings'
  | 'sliders'
  | 'spark'
  | 'stop'
  | 'subtitles'
  | 'trash'
  | 'wave'
  | 'wrench';

type AppIconProps = {
  name: AppIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
};

function AppIcon({ className, name, size = 18, strokeWidth = 1.85, style }: AppIconProps) {
  const commonProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth,
  };

  const icon = (() => {
    switch (name) {
      case 'activity':
        return (
          <>
            <path {...commonProps} d="M3 12h4l2-5 4 10 2-5h6" />
          </>
        );
      case 'alert':
        return (
          <>
            <path {...commonProps} d="M12 4 3 19h18L12 4Z" />
            <path {...commonProps} d="M12 10v4" />
            <path {...commonProps} d="M12 17h.01" />
          </>
        );
      case 'book':
        return (
          <>
            <path {...commonProps} d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5V5.5Z" />
            <path {...commonProps} d="M5 5.5V20.5" />
            <path {...commonProps} d="M9 7h6" />
            <path {...commonProps} d="M9 11h7" />
          </>
        );
      case 'check':
        return <path {...commonProps} d="m5 12 4 4 10-10" />;
      case 'clock':
        return (
          <>
            <circle {...commonProps} cx="12" cy="12" r="9" />
            <path {...commonProps} d="M12 7v5l3 3" />
          </>
        );
      case 'close':
        return (
          <>
            <path {...commonProps} d="M6 6 18 18" />
            <path {...commonProps} d="M18 6 6 18" />
          </>
        );
      case 'cloud':
        return (
          <>
            <path {...commonProps} d="M7 18a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 18.5 9a3.5 3.5 0 1 1 .5 7H7Z" />
          </>
        );
      case 'eye':
        return (
          <>
            <path {...commonProps} d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle {...commonProps} cx="12" cy="12" r="3" />
          </>
        );
      case 'eye-off':
        return (
          <>
            <path {...commonProps} d="M3 3l18 18" />
            <path {...commonProps} d="M10.6 5.3A11.5 11.5 0 0 1 12 5.2c6 0 9.5 6 9.5 6a17.7 17.7 0 0 1-3.3 3.8" />
            <path {...commonProps} d="M6.3 6.4C4.2 7.8 2.5 10.7 2.5 10.7s3.5 6 9.5 6c1.4 0 2.7-.3 3.8-.8" />
            <path {...commonProps} d="M9.9 9.8A3 3 0 0 0 14.2 14" />
          </>
        );
      case 'globe':
        return (
          <>
            <circle {...commonProps} cx="12" cy="12" r="9" />
            <path {...commonProps} d="M3 12h18" />
            <path {...commonProps} d="M12 3a15 15 0 0 1 0 18" />
            <path {...commonProps} d="M12 3a15 15 0 0 0 0 18" />
          </>
        );
      case 'headphones':
        return (
          <>
            <path {...commonProps} d="M4 13a8 8 0 0 1 16 0" />
            <path {...commonProps} d="M5 13h2a2 2 0 0 1 2 2v3H7a2 2 0 0 1-2-2v-3Z" />
            <path {...commonProps} d="M17 13h2v3a2 2 0 0 1-2 2h-2v-3a2 2 0 0 1 2-2Z" />
          </>
        );
      case 'key':
        return (
          <>
            <circle {...commonProps} cx="8.5" cy="12" r="3.5" />
            <path {...commonProps} d="M12 12h8" />
            <path {...commonProps} d="M17 12v3" />
            <path {...commonProps} d="M20 12v2" />
          </>
        );
      case 'layers':
        return (
          <>
            <path {...commonProps} d="m12 4 8 4-8 4-8-4 8-4Z" />
            <path {...commonProps} d="m4 12 8 4 8-4" />
            <path {...commonProps} d="m4 16 8 4 8-4" />
          </>
        );
      case 'lock':
        return (
          <>
            <rect {...commonProps} x="5" y="10" width="14" height="10" rx="2" />
            <path {...commonProps} d="M8 10V8a4 4 0 0 1 8 0v2" />
            <path {...commonProps} d="M12 14v2" />
          </>
        );
      case 'mic':
        return (
          <>
            <rect {...commonProps} x="9" y="4" width="6" height="10" rx="3" />
            <path {...commonProps} d="M6 11a6 6 0 0 0 12 0" />
            <path {...commonProps} d="M12 17v3" />
            <path {...commonProps} d="M9 20h6" />
          </>
        );
      case 'panel':
        return (
          <>
            <rect {...commonProps} x="3" y="4" width="18" height="16" rx="2" />
            <path {...commonProps} d="M9 4v16" />
          </>
        );
      case 'play':
        return <path {...commonProps} d="m9 7 8 5-8 5V7Z" />;
      case 'power':
        return (
          <>
            <path {...commonProps} d="M12 3v8" />
            <path {...commonProps} d="M7.5 5.5a8 8 0 1 0 9 0" />
          </>
        );
      case 'refresh':
        return (
          <>
            <path {...commonProps} d="M20 6v5h-5" />
            <path {...commonProps} d="M4 18v-5h5" />
            <path {...commonProps} d="M19 11a7 7 0 0 0-12-4L4 11" />
            <path {...commonProps} d="M5 13a7 7 0 0 0 12 4l3-4" />
          </>
        );
      case 'route':
        return (
          <>
            <circle {...commonProps} cx="6" cy="6" r="2.5" />
            <circle {...commonProps} cx="18" cy="18" r="2.5" />
            <path {...commonProps} d="M8.5 6H12a4 4 0 0 1 4 4v5.5" />
            <path {...commonProps} d="M15.5 18H12a4 4 0 0 1-4-4V8.5" />
          </>
        );
      case 'search':
        return (
          <>
            <circle {...commonProps} cx="11" cy="11" r="6" />
            <path {...commonProps} d="m20 20-4.2-4.2" />
          </>
        );
      case 'settings':
        return (
          <>
            <path {...commonProps} d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
            <path {...commonProps} d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6Z" />
          </>
        );
      case 'sliders':
        return (
          <>
            <path {...commonProps} d="M4 6h8" />
            <path {...commonProps} d="M16 6h4" />
            <path {...commonProps} d="M4 12h4" />
            <path {...commonProps} d="M12 12h8" />
            <path {...commonProps} d="M4 18h10" />
            <path {...commonProps} d="M18 18h2" />
            <circle {...commonProps} cx="14" cy="6" r="2" />
            <circle {...commonProps} cx="10" cy="12" r="2" />
            <circle {...commonProps} cx="16" cy="18" r="2" />
          </>
        );
      case 'spark':
        return (
          <>
            <path {...commonProps} d="M12 3 14.5 9.5 21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
          </>
        );
      case 'stop':
        return <rect {...commonProps} x="7" y="7" width="10" height="10" rx="1.5" />;
      case 'subtitles':
        return (
          <>
            <rect {...commonProps} x="3" y="5" width="18" height="14" rx="2" />
            <path {...commonProps} d="M7 11h4" />
            <path {...commonProps} d="M13 11h4" />
            <path {...commonProps} d="M7 15h10" />
          </>
        );
      case 'trash':
        return (
          <>
            <path {...commonProps} d="M4 7h16" />
            <path {...commonProps} d="M9 4h6" />
            <path {...commonProps} d="M7 7l1 12a2 2 0 0 0 2 1h4a2 2 0 0 0 2-1l1-12" />
            <path {...commonProps} d="M10 11v5" />
            <path {...commonProps} d="M14 11v5" />
          </>
        );
      case 'wave':
        return (
          <>
            <path {...commonProps} d="M3 12h2l2-4 4 8 2-4h2l2-4 4 8" />
          </>
        );
      case 'wrench':
        return (
          <>
            <path {...commonProps} d="M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3l8-8a4 4 0 0 0-2-7l-2.5 2.5 2 2L11 8l-2-2L11.5 3A4 4 0 0 0 14 6Z" />
          </>
        );
      default:
        return <circle {...commonProps} cx="12" cy="12" r="8" />;
    }
  })();

  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      {icon}
    </svg>
  );
}

export default AppIcon;
