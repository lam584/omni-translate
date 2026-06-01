function clampAlpha(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalizeHexColor(color: string) {
  const normalized = color.trim().replace('#', '');

  if (normalized.length === 3) {
    return normalized
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
  }

  return normalized.length === 6 ? normalized : 'ffffff';
}

export function withAlpha(color: string, alpha: number) {
  const hex = normalizeHexColor(color);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${clampAlpha(alpha)})`;
}

export function mixOpacity(primary: number, secondary: number) {
  return clampAlpha(primary) * clampAlpha(secondary);
}