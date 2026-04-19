import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, msUntilTime } from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };

function buildCtx(opts: { pumpName?: string } = {}) {
  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];

  const ctx = {
    eventBus: { onType: () => () => {} },
    equipmentManager: {
      getById: (id: string) => ({ id, name: opts.pumpName ?? "Pompe", type: "pool_pump" }),
      executeOrder: async (equipmentId: string, alias: string, value: unknown) => {
        orderCalls.push({ equipmentId, alias, value });
        return { success: true };
      },
    },
    zoneManager: { getById: () => null },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    state: {
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: unknown) => {
        state.set(k, v);
      },
      delete: (k: string) => {
        state.delete(k);
      },
      clear: () => state.clear(),
    },
    log: (msg: string) => {
      logLines.push(msg);
    },
    helpers: { parseDuration: () => 0 },
  };

  return { ctx, orderCalls, state, logLines };
}

// ============================================================
// Helpers (exported)
// ============================================================

describe("msUntilTime", () => {
  it("returns ms to a time later today", () => {
    const now = new Date("2026-04-19T08:00:00");
    const ms = msUntilTime("10:30", now);
    // 2h30 = 9_000_000
    expect(ms).toBe(2 * 3600_000 + 30 * 60_000);
  });

  it("returns ms to tomorrow when the time has already passed today", () => {
    const now = new Date("2026-04-19T12:00:00");
    const ms = msUntilTime("10:00", now);
    // 22h ahead
    expect(ms).toBe(22 * 3600_000);
  });

  it("handles midnight-crossing — 23:58 at 23:59 fires tomorrow", () => {
    const now = new Date("2026-04-19T23:59:00");
    const ms = msUntilTime("23:58", now);
    expect(ms).toBe(23 * 3600_000 + 59 * 60_000); // ~23h59
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  const recipe = createRecipe();
  const { ctx } = buildCtx();

  it("rejects when zone is missing", () => {
    expect(() =>
      recipe.validate(
        { pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).toThrow(/zone is required/i);
  });

  it("rejects when pump is missing", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).toThrow(/pump is required/i);
  });

  it("rejects when slot 1 end is missing", () => {
    expect(() =>
      recipe.validate({ zone: "Z1", pump: "P1", slot1_start: "10:00" }, ctx as never),
    ).toThrow(/slot 1 start and end are required/i);
  });

  it("rejects slot 2 start without end", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1", pump: "P1",
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_start: "20:00",
        },
        ctx as never,
      ),
    ).toThrow(/slot 2 end is required/i);
  });

  it("rejects slot 2 end without start", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1", pump: "P1",
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_end: "22:00",
        },
        ctx as never,
      ),
    ).toThrow(/slot 2 start is required/i);
  });

  it("rejects slot with start == end", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "10:00" },
        ctx as never,
      ),
    ).toThrow(/start and end must differ/i);
  });

  it("accepts a single valid slot", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).not.toThrow();
  });

  it("accepts two valid slots", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1", pump: "P1",
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_start: "20:00",
          slot2_end: "22:00",
        },
        ctx as never,
      ),
    ).not.toThrow();
  });
});

// ============================================================
// createInstance()
// ============================================================

describe("createInstance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T08:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires ON at start time and OFF at end time", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );

    // Jump to 10:00 → ON fires
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "ON" });
    expect(state.get("status")).toBe("running");
    expect(state.get("currentSlot")).toBe("10:00-14:00");

    // Jump to 14:00 → OFF fires
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });
    expect(state.get("status")).toBe("idle");
    expect(state.get("currentSlot")).toBe(null);

    handle.stop();
  });

  it("reschedules the slot for the next day after firing", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );

    // First day: trigger both events
    await vi.advanceTimersByTimeAsync(2 * 3600_000); // 10:00 day 1
    await vi.advanceTimersByTimeAsync(4 * 3600_000); // 14:00 day 1

    const after1 = orderCalls.length;
    expect(after1).toBe(2);

    // Next day: jump 24h → should fire both again
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(orderCalls.length).toBe(4);
    expect(orderCalls[2].value).toBe("ON");
    expect(orderCalls[3].value).toBe("OFF");

    handle.stop();
  });

  it("handles midnight-crossing slots", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    vi.setSystemTime(new Date("2026-04-19T23:57:00"));
    const handle = recipe.createInstance(
      { zone: "Z1", pump: "P1", slot1_start: "23:58", slot1_end: "00:02" },
      ctx as never,
    );

    // +1 min → ON (day 1 at 23:58)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "ON" });

    // +4 min more → 00:02 → OFF
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });

    handle.stop();
  });

  it("stop() while idle cancels timers and does not send OFF", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );
    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(orderCalls.length).toBe(0);
  });

  it("stop() while running sends OFF", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );
    // Advance to running state
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "ON" });

    // Stop mid-cycle → OFF must be issued
    handle.stop();
    // Allow microtasks to run
    await vi.advanceTimersByTimeAsync(0);
    const offCalls = orderCalls.filter((c) => c.value === "OFF");
    expect(offCalls.length).toBe(1);
  });
});
