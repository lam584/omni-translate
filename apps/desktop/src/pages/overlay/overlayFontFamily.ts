/** Historical default is also present in existing persisted drafts. */
export const LEGACY_DEFAULT_OVERLAY_FONT_FAMILY = '"Segoe UI", "Microsoft YaHei UI", sans-serif';
export const AUTO_OVERLAY_FONT_FAMILY = 'var(--font-family-sans)';

export function resolveOverlayFontFamily(value: string): string {
  return !value || value === LEGACY_DEFAULT_OVERLAY_FONT_FAMILY || value === AUTO_OVERLAY_FONT_FAMILY
    ? AUTO_OVERLAY_FONT_FAMILY
    : value;
}