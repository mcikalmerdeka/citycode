import { describe, expect, it } from "vitest";
import {
  envUniforms,
  stepEnvUniforms,
  resetEnvUniforms,
  type EnvUniforms,
} from "@/lib/sim/daycycle";

const CLEAR_NOON: EnvUniforms = {
  night: 0,
  dusk: 0,
  lightsOn: 0,
  rain: 0,
  cloud: 0,
  wind: 0,
  wet: 0,
};

/** A rain-night target — every field non-zero. */
const RAIN_NIGHT: EnvUniforms = {
  night: 1,
  dusk: 0.2,
  lightsOn: 1,
  rain: 1,
  cloud: 1,
  wind: 0.8,
  wet: 1,
};

describe("stepEnvUniforms", () => {
  it("converges toward the target values", () => {
    resetEnvUniforms();
    for (let i = 0; i < 600; i++) stepEnvUniforms(RAIN_NIGHT, 1 / 30);
    expect(envUniforms.night).toBeGreaterThan(0.99);
    expect(envUniforms.lightsOn).toBeGreaterThan(0.99);
    expect(envUniforms.rain).toBeGreaterThan(0.99);
    expect(envUniforms.cloud).toBeGreaterThan(0.99);
  });

  it("never overshoots or undershoots [0, 1]", () => {
    resetEnvUniforms();
    for (let i = 0; i < 300; i++) {
      stepEnvUniforms(RAIN_NIGHT, 1 / 30);
      for (const value of Object.values(envUniforms)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("accumulates wetness in the rain and dries when clear", () => {
    resetEnvUniforms();
    // Rain: wet rises even from zero (wet target follows rain).
    for (let i = 0; i < 120; i++) stepEnvUniforms({ ...CLEAR_NOON, rain: 1, cloud: 1 }, 1 / 30);
    const wetAfterRain = envUniforms.wet;
    expect(wetAfterRain).toBeGreaterThan(0.3);
    // Clear: wet dries back down.
    for (let i = 0; i < 600; i++) stepEnvUniforms(CLEAR_NOON, 1 / 30);
    expect(envUniforms.wet).toBeLessThan(0.05);
  });

  it("is a pure time-step: identical call sequences give identical states", () => {
    const run = (): EnvUniforms => {
      resetEnvUniforms();
      for (let i = 0; i < 90; i++) stepEnvUniforms(RAIN_NIGHT, 1 / 30);
      return { ...envUniforms };
    };
    expect(run()).toEqual(run());
  });
});
