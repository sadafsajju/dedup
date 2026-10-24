export interface HSV { h: number; s: number; v: number; a: number }
export const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

export function parseHex(input: string): HSV | null {
  let hex = input.trim().replace(/^#/, "");
  if (!/^(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(hex)) return null;
  if (hex.length < 5) hex = [...hex].map(c => c + c).join("");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const v = Math.max(r, g, b), min = Math.min(r, g, b), d = v - min;
  let h = d === 0 ? 0 : v === r ? ((g - b) / d) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: v === 0 ? 0 : d / v, v, a: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
}

export function toHex({ h, s, v, a }: HSV, alpha = true): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const byte = (n: number) => Math.round(clamp(n) * 255).toString(16).padStart(2, "0");
  return `#${rgb.map(n => byte(n + m)).join("")}${alpha && a < 1 ? byte(a) : ""}`.toUpperCase();
}
