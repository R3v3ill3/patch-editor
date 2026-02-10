// 20 visually distinct colors for patch fills
const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#af7aa1', '#86bcb6', '#d37295', '#8cd17d', '#b6992d',
  '#499894', '#f1ce63', '#d4a6c8', '#a0cbe8', '#ffbe7d',
];

/**
 * Deterministic color for a patch based on its ID or index.
 * Uses a simple hash of the UUID string to pick from the palette.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export function getPatchColor(patchId: string): { fill: string; outline: string; fillWithAlpha: string } {
  const idx = hashString(patchId) % PALETTE.length;
  const color = PALETTE[idx];
  return {
    fill: color,
    outline: color,
    fillWithAlpha: color + '80', // 50% opacity
  };
}

export function getPatchColorByIndex(index: number): { fill: string; outline: string; fillWithAlpha: string } {
  const color = PALETTE[index % PALETTE.length];
  return {
    fill: color,
    outline: color,
    fillWithAlpha: color + '80',
  };
}
