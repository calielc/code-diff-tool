const MIN_TREE_WIDTH = 200
const DEFAULT_TREE_WIDTH = 320

export function clampTreeWidth(px: number, areaWidth: number): number {
  const max = Math.max(MIN_TREE_WIDTH, Math.floor(areaWidth * 0.6))
  return Math.min(max, Math.max(MIN_TREE_WIDTH, Math.round(px)))
}

export function treeWidthFromPointer(clientX: number, areaLeft: number, areaWidth: number): number {
  return clampTreeWidth(clientX - areaLeft - 5, areaWidth)
}

export function nextTreeWidth(current: number, key: 'ArrowLeft' | 'ArrowRight', areaWidth: number): number {
  return clampTreeWidth(current + (key === 'ArrowRight' ? 24 : -24), areaWidth)
}

export function parseStoredTreeWidth(raw: string | null): number {
  if (raw === null) {
    return DEFAULT_TREE_WIDTH
  }
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_TREE_WIDTH ? Math.round(value) : DEFAULT_TREE_WIDTH
  } catch {
    return DEFAULT_TREE_WIDTH
  }
}
