import { describe, expect, it } from "vitest";

import { COMPARE_ACCENTS, BUILDING_COLORS } from "@/lib/city/theme";
import { compareAccent, roofRidgeOrientation } from "@/components/city/compareAccent";

// ---------------------------------------------------------------------------
// compareAccent — pure mapping (compareMode, status) → diorama-safe accents.
// ---------------------------------------------------------------------------

describe("compareAccent", () => {
  it("static mode never tints — roofs stay terracotta, no outline", () => {
    for (const status of [
      "construction",
      "fresh",
      "foundation",
      "rubble",
      "moved",
      "blast",
    ] as const) {
      expect(compareAccent("static", status)).toEqual({});
    }
  });

  it("each compare status maps to its COMPARE_ACCENTS roof tint", () => {
    for (const status of [
      "construction",
      "fresh",
      "foundation",
      "rubble",
      "moved",
      "blast",
    ] as const) {
      const accent = compareAccent("prev", status);
      expect(accent.roofTint).toBe(COMPARE_ACCENTS[status]);
    }
  });

  it("workdir mode maps identically to prev mode", () => {
    expect(compareAccent("workdir", "construction")).toEqual(
      compareAccent("prev", "construction"),
    );
    expect(compareAccent("workdir", "fresh")?.roofTint).toBe(COMPARE_ACCENTS.fresh);
  });

  it("construction and rubble additionally get a base outline ring", () => {
    expect(compareAccent("prev", "construction")?.outline).toBe(
      COMPARE_ACCENTS.construction,
    );
    expect(compareAccent("prev", "rubble")?.outline).toBe(COMPARE_ACCENTS.rubble);
    // The other statuses tint roofs only — no outline ring.
    for (const status of ["fresh", "foundation", "moved", "blast"] as const) {
      expect(compareAccent("prev", status)?.outline).toBeUndefined();
    }
  });

  it("unknown status → no tint (defensive, never throws)", () => {
    expect(
      compareAccent("prev", "not-a-status" as never),
    ).toEqual({});
  });

  it("roof tints never equal the diorama wall colors (walls stay neutral)", () => {
    // foundation is the deliberate exception: its accent IS wallPale — the
    // "freshly poured pale slab" look. Every other status must differ.
    for (const status of ["construction", "fresh", "rubble", "moved", "blast"] as const) {
      const tint = compareAccent("prev", status)?.roofTint;
      expect(tint).not.toBe(BUILDING_COLORS.wallCream);
      expect(tint).not.toBe(BUILDING_COLORS.wallPale);
    }
  });
});

// ---------------------------------------------------------------------------
// roofRidgeOrientation — deterministic hash pick of the gable ridge axis.
// ---------------------------------------------------------------------------

describe("roofRidgeOrientation", () => {
  it("returns only 'x' or 'z'", () => {
    for (let i = 0; i < 50; i++) {
      const o = roofRidgeOrientation(`file-${i}.ts`);
      expect(o === "x" || o === "z").toBe(true);
    }
  });

  it("is deterministic per fileId", () => {
    expect(roofRidgeOrientation("src/a.ts")).toBe(roofRidgeOrientation("src/a.ts"));
  });

  it("produces both orientations across a varied set (variety, not a constant)", () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => roofRidgeOrientation(`mod/file${i}.tsx`)),
    );
    expect(seen.has("x")).toBe(true);
    expect(seen.has("z")).toBe(true);
  });
});
