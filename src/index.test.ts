import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  msUntilTime,
  isInsideWindow,
  scheduledState,
  normalizePumpState,
} from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };

function buildCtx(opts: { pumpName?: string; initialPumpState?: unknown } = {}) {
  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  // Well-behaved device by default: its state follows the orders it receives.
  let pumpState: unknown = opts.initialPumpState ?? "OFF";

  const recordOrder = (equipmentId: string, alias: string, value: unknown) => {
    orderCalls.push({ equipmentId, alias, value });
    if (alias === "state") pumpState = value;
  };

  const ctx = {
    eventBus: {
      onType: (type: string, handler: (event: unknown) => void) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((h) => h !== handler),
          );
        };
      },
    },
    equipmentManager: {
      getById: (id: string) => ({ id, name: opts.pumpName ?? "Pompe", type: "pool_pump" }),
      getDataBindingsWithValues: () => [{ alias: "state", value: pumpState }],
      executeOrder: async (equipmentId: string, alias: string, value: unknown) => {
        recordOrder(equipmentId, alias, value);
        return { success: true };
      },
    },
    dispatchOrder: async (equipmentId: string, alias: string, value: unknown) => {
      recordOrder(equipmentId, alias, value);
      return { success: true };
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

  const emit = (type: string, event: unknown) => {
    for (const h of handlers.get(type) ?? []) h(event);
  };
  const setPumpState = (v: unknown) => {
    pumpState = v;
  };
  const getPumpState = () => pumpState;

  return { ctx, orderCalls, state, logLines, emit, setPumpState, getPumpState };
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

describe("isInsideWindow / scheduledState", () => {
  const day = { index: 1, start: "09:00", end: "17:04" };
  const night = { index: 2, start: "23:00", end: "04:00" };

  it("plain window: inside, before, after", () => {
    expect(isInsideWindow(new Date("2026-04-19T12:00:00"), day)).toBe(true);
    expect(isInsideWindow(new Date("2026-04-19T08:59:00"), day)).toBe(false);
    expect(isInsideWindow(new Date("2026-04-19T17:04:00"), day)).toBe(false);
  });

  it("midnight-crossing window", () => {
    expect(isInsideWindow(new Date("2026-04-19T23:30:00"), night)).toBe(true);
    expect(isInsideWindow(new Date("2026-04-19T03:59:00"), night)).toBe(true);
    expect(isInsideWindow(new Date("2026-04-19T04:00:00"), night)).toBe(false);
    expect(isInsideWindow(new Date("2026-04-19T12:00:00"), night)).toBe(false);
  });

  it("scheduledState reflects the union of windows", () => {
    const windows = [day, night];
    expect(scheduledState(new Date("2026-04-19T12:00:00"), windows)).toBe("ON");
    expect(scheduledState(new Date("2026-04-19T03:00:00"), windows)).toBe("ON");
    expect(scheduledState(new Date("2026-04-19T06:00:00"), windows)).toBe("OFF");
  });
});

describe("normalizePumpState", () => {
  it("maps common wire values", () => {
    expect(normalizePumpState("ON")).toBe("ON");
    expect(normalizePumpState("on")).toBe("ON");
    expect(normalizePumpState(true)).toBe("ON");
    expect(normalizePumpState("OFF")).toBe("OFF");
    expect(normalizePumpState("off")).toBe("OFF");
    expect(normalizePumpState(false)).toBe("OFF");
    expect(normalizePumpState(42)).toBe(null);
    expect(normalizePumpState(undefined)).toBe(null);
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

    // Next day: jump 24h → should fire both again. When a reconcile tick
    // lands exactly on an edge it may duplicate the same (idempotent) order,
    // so assert the transition sequence rather than the raw call count.
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    const transitions = orderCalls
      .map((c) => c.value)
      .filter((v, i, a) => i === 0 || v !== a[i - 1]);
    expect(transitions).toEqual(["ON", "OFF", "ON", "OFF"]);

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

// ============================================================
// Reconciliation (issue #1)
// ============================================================

describe("reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T08:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const params = { zone: "Z1", pump: "P1", slot1_start: "10:00", slot1_end: "14:00" };

  it("corrects a pump found ON outside any window at instance start (incident case)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, logLines } = buildCtx({ initialPumpState: "ON" });
    const handle = recipe.createInstance(params, ctx as never);

    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });
    expect(logLines.some((l) => l.includes("Réconciliation (démarrage)"))).toBe(true);
    handle.stop();
  });

  it("corrects a pump found OFF inside a window at instance start", async () => {
    vi.setSystemTime(new Date("2026-04-19T12:00:00"));
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx({ initialPumpState: "OFF" });
    const handle = recipe.createInstance(params, ctx as never);

    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "ON" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.get("status")).toBe("running");
    expect(state.get("currentSlot")).toBe("10:00-14:00");
    handle.stop();
  });

  it("periodic guard corrects silent drift", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setPumpState } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);
    expect(orderCalls.length).toBe(0);

    setPumpState("ON"); // drift without any order event
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });
    handle.stop();
  });

  it("pump state report triggers an immediate reconcile", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setPumpState, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "P1", alias: "state" });
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });
    handle.stop();
  });

  it("ignores state reports for other equipments or aliases", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setPumpState, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "OTHER", alias: "state" });
    emit("equipment.data.changed", { equipmentId: "P1", alias: "power" });
    expect(orderCalls.length).toBe(0);
    handle.stop();
  });

  it("throttles corrections with a cooldown", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setPumpState, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "P1", alias: "state" });
    expect(orderCalls.length).toBe(1);

    // Device fights back inside the cooldown window: no second order.
    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "P1", alias: "state" });
    expect(orderCalls.length).toBe(1);

    // After the cooldown, the correction fires again.
    await vi.advanceTimersByTimeAsync(61_000);
    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "P1", alias: "state" });
    expect(orderCalls.length).toBe(2);
    handle.stop();
  });

  it("manual order sets a dérogation that stands until the next edge", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state, setPumpState, emit, logLines } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    // User forces the pump ON at 08:00 (outside any window).
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
      source: { kind: "manual", userId: "u1" },
    });
    setPumpState("ON");
    expect(state.get("override")).toBe(true);
    expect(logLines.some((l) => l.includes("dérogation"))).toBe(true);

    // Reconciliation stands down.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(orderCalls.length).toBe(0);

    // Next edge (10:00 start) clears the dérogation and drives the pump again.
    await vi.advanceTimersByTimeAsync(110 * 60_000);
    expect(state.get("override")).toBe(false);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "ON" });

    // Drift after the edge is corrected again.
    setPumpState("OFF");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const onCalls = orderCalls.filter((c) => c.value === "ON");
    expect(onCalls.length).toBe(2);
    handle.stop();
  });

  it("recipe-sourced orders do not set the dérogation", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state, setPumpState, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
      source: { kind: "recipe", instanceId: "self" },
    });
    expect(state.get("override")).not.toBe(true);

    setPumpState("ON");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(orderCalls).toContainEqual({ equipmentId: "P1", alias: "state", value: "OFF" });
    handle.stop();
  });

  it("sourceless order events right after an own dispatch do not set the dérogation", async () => {
    const recipe = createRecipe();
    const { ctx, state, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    // Reach the 10:00 edge: the recipe dispatches its own ON.
    await vi.advanceTimersByTimeAsync(2 * 3600_000);

    // A sourceless echo of that order arrives within the grace window.
    emit("equipment.order.executed", { equipmentId: "P1", orderAlias: "state" });
    expect(state.get("override")).not.toBe(true);

    // A sourceless order long after the grace window is treated as manual.
    await vi.advanceTimersByTimeAsync(6_000);
    emit("equipment.order.executed", { equipmentId: "P1", orderAlias: "state" });
    expect(state.get("override")).toBe(true);
    handle.stop();
  });

  it("persisted dérogation survives a restart and stands down reconciliation", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state, setPumpState } = buildCtx({ initialPumpState: "ON" });
    state.set("override", true); // persisted from a previous run
    setPumpState("ON");
    const handle = recipe.createInstance(params, ctx as never);

    // Startup reconcile must NOT correct: the user's choice stands.
    expect(orderCalls.length).toBe(0);
    handle.stop();
  });
});
