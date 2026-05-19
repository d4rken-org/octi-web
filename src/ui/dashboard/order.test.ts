import { describe, expect, it } from "vitest";
import { sortDevicesSelfFirst } from "./order";

const mk = (id: string) => ({ raw: { id } });

describe("sortDevicesSelfFirst", () => {
  it("moves self to position 0, preserves peer order", () => {
    const list = [mk("a"), mk("b"), mk("self"), mk("c")];
    const out = sortDevicesSelfFirst(list, "self");
    expect(out.map((d) => d.raw.id)).toEqual(["self", "a", "b", "c"]);
  });

  it("is a no-op when self is already first", () => {
    const list = [mk("self"), mk("a"), mk("b")];
    const out = sortDevicesSelfFirst(list, "self");
    expect(out.map((d) => d.raw.id)).toEqual(["self", "a", "b"]);
  });

  it("returns a fresh array even when self is already first (no mutation contract)", () => {
    const list = [mk("self"), mk("a")];
    const out = sortDevicesSelfFirst(list, "self");
    expect(out).not.toBe(list);
  });

  it("returns input order when self is absent", () => {
    const list = [mk("a"), mk("b"), mk("c")];
    const out = sortDevicesSelfFirst(list, "missing");
    expect(out.map((d) => d.raw.id)).toEqual(["a", "b", "c"]);
  });

  it("handles single-device lists (just self)", () => {
    expect(sortDevicesSelfFirst([mk("self")], "self").map((d) => d.raw.id)).toEqual(["self"]);
  });

  it("handles empty lists", () => {
    expect(sortDevicesSelfFirst([], "self")).toEqual([]);
  });

  it("is idempotent across two calls", () => {
    const list = [mk("a"), mk("self"), mk("b")];
    const once = sortDevicesSelfFirst(list, "self");
    const twice = sortDevicesSelfFirst(once, "self");
    expect(twice.map((d) => d.raw.id)).toEqual(once.map((d) => d.raw.id));
  });

  it("does not mutate the input array", () => {
    const list = [mk("a"), mk("self"), mk("b")];
    const before = list.map((d) => d.raw.id);
    sortDevicesSelfFirst(list, "self");
    expect(list.map((d) => d.raw.id)).toEqual(before);
  });
});
