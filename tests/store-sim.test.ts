import { beforeEach, describe, expect, it } from "vitest";
import { useCityStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Additive sim/time-of-day store fields (Wave 0). Every pre-existing field
// keeps its semantics — these tests only cover the NEW fields.
// ---------------------------------------------------------------------------

describe("store sim fields", () => {
  beforeEach(() => {
    // Reset to defaults between tests so ordering never matters.
    useCityStore.setState({
      timeOfDay: "noon",
      weather: "clear",
      simEnabled: true,
      resetViewRequest: 0,
    });
  });

  it("defaults: noon, clear, simEnabled true, resetViewRequest 0", () => {
    const s = useCityStore.getState();
    expect(s.timeOfDay).toBe("noon");
    expect(s.weather).toBe("clear");
    expect(s.simEnabled).toBe(true);
    expect(s.resetViewRequest).toBe(0);
  });

  it("setTimeOfDay switches the day phase", () => {
    useCityStore.getState().setTimeOfDay("sunset");
    expect(useCityStore.getState().timeOfDay).toBe("sunset");
    useCityStore.getState().setTimeOfDay("night");
    expect(useCityStore.getState().timeOfDay).toBe("night");
  });

  it("setWeather switches the weather", () => {
    useCityStore.getState().setWeather("rain");
    expect(useCityStore.getState().weather).toBe("rain");
    useCityStore.getState().setWeather("cloudy");
    expect(useCityStore.getState().weather).toBe("cloudy");
  });

  it("toggleSim flips simEnabled", () => {
    useCityStore.getState().toggleSim();
    expect(useCityStore.getState().simEnabled).toBe(false);
    useCityStore.getState().toggleSim();
    expect(useCityStore.getState().simEnabled).toBe(true);
  });

  it("requestResetView increments the counter twice → 2", () => {
    useCityStore.getState().requestResetView();
    useCityStore.getState().requestResetView();
    expect(useCityStore.getState().resetViewRequest).toBe(2);
  });
});
