/**
 * Polyline helpers for the data packet's travel — pure ground-plane math.
 */

export interface Pt {
  x: number;
  z: number;
}

export function polylineLength(points: readonly Pt[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  }
  return length;
}

/**
 * The point `fraction` (0..1) of the way along the polyline by arc length.
 * Degenerate input is handled rather than thrown on: an empty polyline is
 * the origin, a zero-length one is its first point.
 */
export function pointAlong(points: readonly Pt[], fraction: number): Pt {
  if (points.length === 0) return { x: 0, z: 0 };
  const total = polylineLength(points);
  if (points.length === 1 || total === 0) return { x: points[0]!.x, z: points[0]!.z };
  const target = Math.min(1, Math.max(0, fraction)) * total;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + segment >= target && segment > 0) {
      const k = (target - walked) / segment;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
    }
    walked += segment;
  }
  const last = points[points.length - 1]!;
  return { x: last.x, z: last.z };
}
