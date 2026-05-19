import { describe, expect, it } from "vitest";
import { computeTileRows } from "./tile-rows";

const empty = { order: [], wide: [], hidden: [] };

describe("computeTileRows", () => {
  it("returns no rows for an empty layout", () => {
    expect(computeTileRows(empty)).toEqual([]);
  });

  it("pairs two narrow tiles", () => {
    const rows = computeTileRows({ order: ["a", "b"], wide: [], hidden: [] });
    expect(rows).toEqual([{ kind: "pair", ids: ["a", "b"] }]);
  });

  it("renders a lone trailing narrow tile as a single (full-width) row", () => {
    const rows = computeTileRows({ order: ["a", "b", "c"], wide: [], hidden: [] });
    expect(rows).toEqual([
      { kind: "pair", ids: ["a", "b"] },
      { kind: "single", ids: ["c"] },
    ]);
  });

  it("emits a wide row when a tile is in the `wide` set", () => {
    const rows = computeTileRows({ order: ["hero", "b", "c"], wide: ["hero"], hidden: [] });
    expect(rows).toEqual([
      { kind: "wide", ids: ["hero"] },
      { kind: "pair", ids: ["b", "c"] },
    ]);
  });

  it("a narrow tile followed by a wide one renders as a single, then wide", () => {
    const rows = computeTileRows({
      order: ["a", "wide", "b", "c"],
      wide: ["wide"],
      hidden: [],
    });
    expect(rows).toEqual([
      { kind: "single", ids: ["a"] },
      { kind: "wide", ids: ["wide"] },
      { kind: "pair", ids: ["b", "c"] },
    ]);
  });

  it("hides modules listed in `hidden` (they neither render nor consume a pair slot)", () => {
    const rows = computeTileRows({
      order: ["a", "hide", "b", "c"],
      wide: [],
      hidden: ["hide"],
    });
    expect(rows).toEqual([
      { kind: "pair", ids: ["a", "b"] },
      { kind: "single", ids: ["c"] },
    ]);
  });

  it("hiding all tiles yields no rows", () => {
    const rows = computeTileRows({
      order: ["a", "b", "c"],
      wide: [],
      hidden: ["a", "b", "c"],
    });
    expect(rows).toEqual([]);
  });

  it("default Android-style layout: hero Power + pairs", () => {
    const rows = computeTileRows({
      order: ["power", "wifi", "connectivity", "clipboard", "files", "apps", "meta"],
      wide: ["power"],
      hidden: [],
    });
    expect(rows).toEqual([
      { kind: "wide", ids: ["power"] },
      { kind: "pair", ids: ["wifi", "connectivity"] },
      { kind: "pair", ids: ["clipboard", "files"] },
      { kind: "pair", ids: ["apps", "meta"] },
    ]);
  });
});
