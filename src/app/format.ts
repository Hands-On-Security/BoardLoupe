import type { UnitInfo } from '../model/types';

function trim(n: number, digits: number) {
  return n.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

/**
 * Formats a model-space length. With known units shows millimetres plus the
 * native unit; with unknown units shows the raw value labelled as such.
 */
export function formatLength(v: number, u: UnitInfo, short = false): string {
  if (u.toMm === null || u.unit === 'unknown') return `${trim(v, 2)} units`;
  const mm = v * u.toMm;
  const mmStr = `${trim(mm, mm < 1 ? 3 : 2)} mm`;
  if (short) return mmStr;
  if (u.unit === 'mil') return `${mmStr} (${trim(v, 1)} mil)`;
  if (u.unit === 'inch') return `${mmStr} (${trim(v * 1000, 1)} mil)`;
  return mmStr;
}

export function formatCoord(x: number, y: number, u: UnitInfo): string {
  const d = u.unit === 'mm' ? 3 : u.unit === 'inch' ? 4 : 1;
  const unit = u.unit === 'unknown' ? '' : ` ${u.unit}`;
  return `${trim(x, d)}, ${trim(y, d)}${unit}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function plural(n: number, w: string) {
  return `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
}
