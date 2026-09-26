import { describe, expect, it } from "vitest";
import {
  BUILDING_COLORS,
  COMPARE_ACCENTS,
  GROUND_COLORS,
  PAGE_COLORS,
  SHADER_UNIFORMS,
  SIM_COLORS,
  TREE_COLORS,
} from "@/lib/city/theme";

// ---------------------------------------------------------------------------
// Palette groups exist and every value is a valid 6-digit hex string.
// ---------------------------------------------------------------------------

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

describe("theme palettes", () => {
  it("exports every palette group", () => {
    expect(PAGE_COLORS).toBeDefined();
    expect(GROUND_COLORS).toBeDefined();
    expect(BUILDING_COLORS).toBeDefined();
    expect(TREE_COLORS).toBeDefined();
    expect(SIM_COLORS).toBeDefined();
    expect(COMPARE_ACCENTS).toBeDefined();
  });

  it("all palette values are valid hex strings (string or array of)", () => {
    const groups = [
      PAGE_COLORS,
      GROUND_COLORS,
      BUILDING_COLORS,
      TREE_COLORS,
      SIM_COLORS,
      COMPARE_ACCENTS,
    ] as Record<string, unknown>[];
    for (const group of groups) {
      for (const [key, value] of Object.entries(group)) {
        if (typeof value === "string") {
          expect(value, `${key}`).toMatch(HEX_RE);
        } else {
          expect(Array.isArray(value), `${key} is a string or hex array`).toBe(true);
          for (const hex of value as string[]) {
            expect(hex, `${key}[]`).toMatch(HEX_RE);
          }
        }
      }
    }
  });

  it("PAGE_COLORS has page and backdrop", () => {
    expect(PAGE_COLORS.page).toBe("#F7F7F8");
    expect(PAGE_COLORS.backdrop).toBe("#e8e9e4");
  });

  it("GROUND_COLORS has the required ground keys", () => {
    for (const key of [
      "lawn",
      "yard",
      "plaza",
      "sidewalk",
      "curb",
      "asphalt",
      "marking",
      "backdrop",
    ]) {
      expect(GROUND_COLORS).toHaveProperty(key);
    }
    expect(GROUND_COLORS.lawn).toBe("#A9B797");
    expect(GROUND_COLORS.yard).toBe("#D0D3C3");
    expect(GROUND_COLORS.plaza).toBe("#D9D1C3");
    expect(GROUND_COLORS.sidewalk).toBe("#D7D1C6");
    expect(GROUND_COLORS.curb).toBe("#E6E1D8");
    expect(GROUND_COLORS.asphalt).toBe("#77746F");
    expect(GROUND_COLORS.marking).toBe("#ECE7DC");
  });

  it("BUILDING_COLORS has the required building keys", () => {
    for (const key of ["wallCream", "wallPale", "roofTerracotta", "redbrick"]) {
      expect(BUILDING_COLORS).toHaveProperty(key);
    }
    expect(BUILDING_COLORS.wallCream).toBe("#D9D3C9");
    expect(BUILDING_COLORS.wallPale).toBe("#E8E2D6");
    expect(BUILDING_COLORS.roofTerracotta).toBe("#B8674A");
    expect(BUILDING_COLORS.redbrick).toBe("#A0522D");
  });

  it("TREE_COLORS has canopy and trunk keys", () => {
    expect(TREE_COLORS).toHaveProperty("canopySage");
    expect(TREE_COLORS).toHaveProperty("canopyAutumn");
    expect(TREE_COLORS).toHaveProperty("trunk");
  });

  it("SIM_COLORS has shirts, pants, skins, vehicleBody arrays of the right size", () => {
    expect(SIM_COLORS.shirts.length).toBeGreaterThanOrEqual(4);
    expect(SIM_COLORS.pants.length).toBeGreaterThanOrEqual(4);
    expect(SIM_COLORS.skins.length).toBeGreaterThanOrEqual(3);
    expect(SIM_COLORS.vehicleBody.length).toBeGreaterThanOrEqual(3);
  });

  it("COMPARE_ACCENTS mirrors the Buildings.tsx status names", () => {
    // Keys must match the compare statuses the renderer already knows:
    // construction, fresh, foundation, rubble, moved, blast.
    for (const key of [
      "construction",
      "fresh",
      "foundation",
      "rubble",
      "moved",
      "blast",
    ]) {
      expect(COMPARE_ACCENTS).toHaveProperty(key);
    }
  });

  it("SHADER_UNIFORMS is exactly the shader uniform tuple", () => {
    expect(SHADER_UNIFORMS).toEqual([
      "night",
      "dusk",
      "lightsOn",
      "rain",
      "cloud",
      "wind",
      "wet",
    ]);
  });
});
