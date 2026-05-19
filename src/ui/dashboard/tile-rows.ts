import type { TileLayout } from "../../modules/module-registry";

/**
 * Pure row-computation for the tile grid. Mirrors Android's
 * `TileLayoutConfig.toRows()`:
 *
 *   - Walk the (non-hidden) `order` left-to-right.
 *   - If the current tile is `wide`, emit a single-tile `wide` row.
 *   - Otherwise if the next tile exists and is also not `wide`, emit a
 *     two-tile `pair` row and skip both.
 *   - Otherwise (last tile, or next tile is wide) emit a single-tile `single`
 *     row that renders full-width.
 *
 * Kept pure + outside the Svelte component so we can pin the behavior via
 * Vitest goldens — it's the easiest place to drift away from Android.
 */
export type TileRow =
  | { kind: "wide"; ids: [string] }
  | { kind: "pair"; ids: [string, string] }
  | { kind: "single"; ids: [string] };

export function computeTileRows(layout: TileLayout): TileRow[] {
  const hidden = new Set(layout.hidden);
  const wide = new Set(layout.wide);
  const visible = layout.order.filter((id) => !hidden.has(id));
  const rows: TileRow[] = [];
  let i = 0;
  while (i < visible.length) {
    const id = visible[i];
    if (wide.has(id)) {
      rows.push({ kind: "wide", ids: [id] });
      i++;
    } else if (i + 1 < visible.length && !wide.has(visible[i + 1])) {
      rows.push({ kind: "pair", ids: [id, visible[i + 1]] });
      i += 2;
    } else {
      rows.push({ kind: "single", ids: [id] });
      i++;
    }
  }
  return rows;
}
