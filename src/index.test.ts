import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  msUntilTime,
  isInsideWindow,
  scheduledState,
  normalizePumpState,
  computeTargetHours,
} from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };

function buildCtx(
  opts: {
    pumpName?: string;
    initialPumpState?: unknown;
    waterTemp?: number;
    tariff?: unknown;
    sunlight?: unknown;
    energy?: unknown;
  } = {},
) {
  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  // Well-behaved device by default: its state follows the orders it receives.
  let pumpState: unknown = opts.initialPumpState ?? "OFF";
  let waterTemp: unknown = opts.waterTemp; // WT1 sensor reading

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
      getById: (id: string) => ({
        id,
        name: opts.pumpName ?? "Pompe",
        type: "pool_pump",
      }),
      getDataBindingsWithValues: (id: string) =>
        id === "WT1"
          ? [{ alias: "temperature", value: waterTemp }]
          : [{ alias: "state", value: pumpState }],
      executeOrder: async (
        equipmentId: string,
        alias: string,
        value: unknown,
      ) => {
        recordOrder(equipmentId, alias, value);
        return { success: true };
      },
    },
    dispatchOrder: async (
      equipmentId: string,
      alias: string,
      value: unknown,
    ) => {
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
    helpers: {
      parseDuration: () => 0,
      ...(opts.tariff !== undefined ? { getTariff: () => opts.tariff } : {}),
      ...(opts.sunlight !== undefined
        ? { getSunlight: () => opts.sunlight }
        : {}),
      ...(opts.energy !== undefined ? { energy: opts.energy } : {}),
    },
  };

  const emit = (type: string, event: unknown) => {
    for (const h of handlers.get(type) ?? []) h(event);
  };
  const setPumpState = (v: unknown) => {
    pumpState = v;
  };
  const setWaterTemp = (v: unknown) => {
    waterTemp = v;
  };
  const getPumpState = () => pumpState;

  return {
    ctx,
    orderCalls,
    state,
    logLines,
    emit,
    setPumpState,
    setWaterTemp,
    getPumpState,
  };
}

// Fake capacity arbiter (spec 140). grant()/revoke() drive the recipe's
// onGranted/onRevoked callbacks, as the real arbiter would.
function makeArbiter(opts?: { enabled?: boolean; denied?: boolean }) {
  const enabled = opts?.enabled ?? true;
  let status: "pending" | "granted" | "denied" | "released" = "pending";
  let req: { onGranted: () => void; onRevoked: (r: string) => void } | null =
    null;
  const handle = {
    id: "claim-1",
    status: () => status,
    deniedReason: opts?.denied ? "not-profiled" : undefined,
    release: () => {
      status = "released";
    },
  };
  return {
    energy: {
      claimCapacity: (r: {
        onGranted: () => void;
        onRevoked: (r: string) => void;
      }) => {
        req = r;
        status = opts?.denied ? "denied" : "pending";
        return handle;
      },
      getCapacityState: () => ({
        enabled,
        availableSurplusW: enabled ? 800 : null,
        grants: [],
      }),
    },
    grant: () => {
      if (status === "pending") {
        status = "granted";
        req?.onGranted();
      }
    },
    revoke: () => {
      if (status === "granted") {
        status = "pending";
        req?.onRevoked("surplus-deficit");
      }
    },
    claimed: () => req !== null && status !== "released",
  };
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
    expect(scheduledState(new Date("2026-04-19T06:00:00"), windows)).toBe(
      "OFF",
    );
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
      recipe.validate(
        { zone: "Z1", pump: "P1", slot1_start: "10:00" },
        ctx as never,
      ),
    ).toThrow(/slot 1 start and end are required/i);
  });

  it("rejects slot 2 start without end", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1",
          pump: "P1",
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
          zone: "Z1",
          pump: "P1",
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

  it("auto mode (water sensor set) does not require a fixed window", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", pump: "P1", waterTempSensor: "WT1" },
        ctx as never,
      ),
    ).not.toThrow();
  });

  it("schedule mode (no water sensor) still requires slot 1", () => {
    expect(() =>
      recipe.validate({ zone: "Z1", pump: "P1" }, ctx as never),
    ).toThrow(/slot 1/i);
  });

  it("does not mark slot 1 as required at the schema level (UI must allow clearing it in auto mode)", () => {
    // Slot 1 is only conditionally required (schedule mode). A static
    // required:true would let the UI block clearing it even with a water sensor
    // set — validate() enforces the real rule instead.
    const slots = recipe.slots as Array<{ id: string; required: boolean }>;
    expect(slots.find((s) => s.id === "slot1_start")?.required).toBe(false);
    expect(slots.find((s) => s.id === "slot1_end")?.required).toBe(false);
  });

  it("accepts two valid slots", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1",
          pump: "P1",
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
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "ON",
    });
    expect(state.get("status")).toBe("running");
    expect(state.get("currentSlot")).toBe("10:00-14:00");

    // Jump to 14:00 → OFF fires
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });
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
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "ON",
    });

    // +4 min more → 00:02 → OFF
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });

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
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "ON",
    });

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

  const params = {
    zone: "Z1",
    pump: "P1",
    slot1_start: "10:00",
    slot1_end: "14:00",
  };

  it("corrects a pump found ON outside any window at instance start (incident case)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, logLines } = buildCtx({ initialPumpState: "ON" });
    const handle = recipe.createInstance(params, ctx as never);

    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });
    expect(logLines.some((l) => l.includes("Réconciliation (démarrage)"))).toBe(
      true,
    );
    handle.stop();
  });

  it("corrects a pump found OFF inside a window at instance start", async () => {
    vi.setSystemTime(new Date("2026-04-19T12:00:00"));
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx({ initialPumpState: "OFF" });
    const handle = recipe.createInstance(params, ctx as never);

    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "ON",
    });
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
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });
    handle.stop();
  });

  it("pump state report triggers an immediate reconcile", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setPumpState, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    setPumpState("ON");
    emit("equipment.data.changed", { equipmentId: "P1", alias: "state" });
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });
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
    expect(logLines.some((l) => l.toLowerCase().includes("dérogation"))).toBe(
      true,
    );

    // Reconciliation stands down.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(orderCalls.length).toBe(0);

    // Next edge (10:00 start) clears the dérogation and drives the pump again.
    await vi.advanceTimersByTimeAsync(110 * 60_000);
    expect(state.get("override")).toBe(false);
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "ON",
    });

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
    expect(orderCalls).toContainEqual({
      equipmentId: "P1",
      alias: "state",
      value: "OFF",
    });
    handle.stop();
  });

  it("a core delivery-retry replay is not a manual order (#24)", async () => {
    // Incident 2026-08-29: a network outage left the recipe's own orders
    // undelivered; when the equipment came back the core replayed the last one
    // as {kind:"external", channel:"delivery-retry"}, long past the own-dispatch
    // grace. The recipe read its own order as a human's and latched a
    // dérogation, sitting out a whole afternoon of free surplus.
    const recipe = createRecipe();
    const { ctx, state, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    await vi.advanceTimersByTimeAsync(6_000); // past the own-dispatch grace
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
      source: { kind: "external", channel: "delivery-retry" },
    });
    expect(state.get("override")).not.toBe(true);

    // Any other external channel is still somebody else driving the pump.
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
      source: { kind: "external", channel: "mqtt" },
    });
    expect(state.get("override")).toBe(true);
    handle.stop();
  });

  it("sourceless order events right after an own dispatch do not set the dérogation", async () => {
    const recipe = createRecipe();
    const { ctx, state, emit } = buildCtx();
    const handle = recipe.createInstance(params, ctx as never);

    // Reach the 10:00 edge: the recipe dispatches its own ON.
    await vi.advanceTimersByTimeAsync(2 * 3600_000);

    // A sourceless echo of that order arrives within the grace window.
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
    });
    expect(state.get("override")).not.toBe(true);

    // A sourceless order long after the grace window is treated as manual.
    await vi.advanceTimersByTimeAsync(6_000);
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
    });
    expect(state.get("override")).toBe(true);
    handle.stop();
  });

  it("persisted dérogation survives a restart and stands down reconciliation", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state, setPumpState } = buildCtx({
      initialPumpState: "ON",
    });
    state.set("override", true); // persisted from a previous run
    setPumpState("ON");
    const handle = recipe.createInstance(params, ctx as never);

    // Startup reconcile must NOT correct: the user's choice stands.
    expect(orderCalls.length).toBe(0);
    handle.stop();
  });

  it("schedule mode: a dérogation survives the 06:00 rollover (lifts only at a window edge)", async () => {
    // The auto-mode 06:00 backstop must NOT bleed into schedule mode, whose
    // documented contract holds the dérogation until the next configured edge.
    vi.setSystemTime(new Date("2026-08-06T15:00:00")); // after the 14:00 window end
    const recipe = createRecipe();
    const { ctx, state, setPumpState, emit } = buildCtx(); // schedule mode (no water sensor)
    const handle = recipe.createInstance(params, ctx as never);
    await vi.advanceTimersByTimeAsync(6_000); // clear the own-order grace
    emit("equipment.order.executed", {
      equipmentId: "P1",
      orderAlias: "state",
      source: { kind: "manual", userId: "u1" },
    });
    setPumpState("ON");
    expect(state.get("override")).toBe(true);
    await vi.advanceTimersByTimeAsync(15.5 * 3600_000); // 06:30 next day: crosses 06:00, no window edge
    expect(state.get("override")).toBe(true); // still held — schedule contract unbroken
    handle.stop();
  });
});

// ============================================================
// Smart filtration (v1.2.0): water-temp target + solar surplus
// ============================================================

describe("smart filtration (v1.2.0, auto model)", () => {
  it("computeTargetHours is linear, capped at maxHours@refTemp, floored at minHours", () => {
    const o = { maxHours: 12, refTemp: 30, minHours: 3 };
    expect(computeTargetHours(30, o)).toBe(12); // cap reached at the reference
    expect(computeTargetHours(20, o)).toBe(8); // 20 * 12/30
    expect(computeTargetHours(15, o)).toBe(6);
    expect(computeTargetHours(35, o)).toBe(12); // above the reference → still capped
    expect(computeTargetHours(5, o)).toBe(3); // 2 floored to 3
    expect(computeTargetHours(Number.NaN, o)).toBe(3); // invalid → floor
  });

  describe("instance", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Full daylight 07:00-20:00 and the owner's HC slots.
    const SUN = { sunrise: "07:00", sunset: "20:00", isDaylight: true };
    const TARIFF = {
      configured: true,
      offPeakToday: [
        { start: "00:04", end: "05:34" },
        { start: "14:34", end: "17:04" },
      ],
      isOffPeakNow: null,
    };
    const AUTO = { zone: "Z1", pump: "P1", waterTempSensor: "WT1" };
    const onCount = (calls: OrderCall[]) =>
      calls.filter((c) => c.value === "ON").length;

    it("computes and displays a daily target from the current water temp on day one", () => {
      vi.setSystemTime(new Date("2026-08-06T08:00:00"));
      const { ctx, state } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(state.get("targetHours")).toBe(10); // 25 * 12/30
      expect(state.get("waterTempUsed")).toBe(25);
      handle.stop();
    });

    it("publishes state.summary with progress + the active rule (recipe card status line)", () => {
      vi.setSystemTime(new Date("2026-08-06T18:00:00")); // near sunset → daytime floor drives it ON
      const { ctx, state } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      const summary = state.get("summary");
      expect(typeof summary).toBe("string");
      expect(summary).toContain("Filtration");
      expect(summary).toContain("/10 h"); // target 10 h (25 * 12/30)
      expect(summary).toContain("journée"); // the active rung
      handle.stop();
    });

    it("auto enabled mid-filtration-day seeds the target immediately (no 0 until 06:00)", () => {
      // Same filtration day already recorded → rolloverIfNeeded early-returns, so
      // without the init seed the target would stay unset until the next 06:00.
      vi.setSystemTime(new Date("2026-08-06T15:00:00"));
      const { ctx, state } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      state.set("day", "2026-08-06"); // mid-day switch to auto (day already set)
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(state.get("targetHours")).toBe(10); // seeded now from the current reading, not 0
      handle.stop();
    });

    it("seeds the target from yesterday's average when available (not the current reading)", () => {
      vi.setSystemTime(new Date("2026-08-06T15:00:00"));
      const { ctx, state } = buildCtx({
        waterTemp: 30,
        sunlight: SUN,
        tariff: TARIFF,
      }); // now 30 → would be 12h
      state.set("day", "2026-08-06");
      state.set("waterTempYesterday", 20); // yesterday avg 20 → 8h wins
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(state.get("targetHours")).toBe(8); // 20 * 12/30, yesterday's average preferred
      expect(state.get("waterTempUsed")).toBe(20);
      handle.stop();
    });

    it("rule 1: solar surplus runs the pump even outside off-peak and daylight", async () => {
      // 20:30 past sunset, no HC; waterTemp 20 → 8 h target, small enough that the
      // deadline catch-up has slack and does not fire yet → only surplus can run.
      vi.setSystemTime(new Date("2026-08-06T20:30:00"));
      const arb = makeArbiter();
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: true },
        ctx as never,
      );
      expect(arb.claimed()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(onCount(orderCalls)).toBe(0); // no rule fires without a grant
      arb.grant();
      await vi.advanceTimersByTimeAsync(1);
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      arb.revoke();
      await vi.advanceTimersByTimeAsync(1);
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "OFF",
      });
      handle.stop();
    });

    it("rule 2: runs during an off-peak (HC) slot to catch up", () => {
      // sunset 13:00 so 14:40 is NOT daytime → isolates HC from the daytime floor.
      vi.setSystemTime(new Date("2026-08-06T14:40:00"));
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: { sunrise: "07:00", sunset: "13:00", isDaylight: true },
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("rule 3: the daytime floor is DEFERRED toward sunset, not run at midday", () => {
      // At midday with no surplus and no HC, the floor waits (prefers free
      // surplus / off-peak first) — it must NOT run eagerly.
      vi.setSystemTime(new Date("2026-08-06T11:00:00")); // daytime, not in an HC slot
      const a = buildCtx({ waterTemp: 25, sunlight: SUN, tariff: TARIFF });
      const h1 = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        a.ctx as never,
      );
      expect(a.orderCalls.some((c) => c.value === "ON")).toBe(false); // deferred
      h1.stop();
    });

    it("rule 3: the daytime floor DOES fire near sunset (deficit can't be deferred further)", () => {
      // SUN sunset 20:00, floor 3 h → at 18:00 only 2 h of daylight remain < 3 h deficit.
      vi.setSystemTime(new Date("2026-08-06T18:00:00"));
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("deferred floor: morning surplus satisfies the daytime minimum → no peak-price floor later", async () => {
      // Sunny morning: surplus runs the pump in daylight, accumulating the daytime
      // minimum for free, so the floor never has to force peak-price running.
      vi.setSystemTime(new Date("2026-08-06T08:00:00"));
      const arb = makeArbiter();
      const { ctx, getPumpState } = buildCtx({
        waterTemp: 25,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: true, daytimeMinHours: 2 },
        ctx as never,
      );
      arb.grant();
      await vi.advanceTimersByTimeAsync(2.5 * 3600_000); // 2.5 h of free surplus in daylight
      arb.revoke();
      await vi.advanceTimersByTimeAsync(60_000);
      // Daytime minimum (2 h) already covered by surplus → the floor stays down.
      vi.setSystemTime(new Date("2026-08-06T18:00:00"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getPumpState()).toBe("OFF"); // no forced peak-price floor
      handle.stop();
    });

    it("rule 4: runs the pre-dawn night safety net so the target is met", () => {
      vi.setSystemTime(new Date("2026-08-06T05:50:00")); // after night HC, before the 06:00 boundary
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("rule 4 latches: no ON/OFF chatter at the deadline threshold crossing", async () => {
      // Regression (prod 2026-08-14): at night the deadline rung sat on the
      // knife-edge remainingH ≈ hoursUntilBoundary and the raw `>=` flipped
      // tick-to-tick, toggling the pump ON/OFF every ~30 s. Once engaged, the
      // rung must LATCH ON until the target is met, so a hair of runtime jitter
      // that nudges remainingH back under the boundary no longer flips it OFF.
      vi.setSystemTime(new Date("2026-08-14T23:12:00")); // night, past sunset, no HC slot
      const { ctx, state, orderCalls, getPumpState } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      // Seed the crossing directly: target 11 h, 4.2 h done → remaining 6.8 h,
      // and hoursUntilBoundary at 23:12 is exactly (06:00 − 23:12) = 6.8 h.
      state.set("day", "2026-08-14"); // same filtration day → no target recompute
      state.set("targetHours", 11);
      state.set("runSecondsToday", 4.2 * 3600);
      state.set("daytimeSecondsToday", 3 * 3600); // daytime floor already satisfied
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      // The deadline engages: the pump is commanded ON.
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      // Model the float/measurement jitter that flipped the raw threshold on
      // prod: bump runtime a few seconds so remainingH dips just under the
      // (now smaller) boundary. Pre-fix this makes the next tick compute OFF.
      state.set("runSecondsToday", 4.21 * 3600 + 40);
      await vi.advanceTimersByTimeAsync(3 * 30_000); // a few accounting ticks
      // Latched: it never turns the pump back OFF while still below target.
      expect(orderCalls.filter((c) => c.value === "OFF")).toHaveLength(0);
      expect(getPumpState()).toBe("ON");
      handle.stop();
    });

    it("rule 3 latches: no ON/OFF chatter at the daytime-floor sunset crossing", async () => {
      // Regression (prod 2026-08-15, ~20:24): the DEFERRED daytime floor has the
      // same knife-edge as rule 4 — deficitH ≈ hoursUntilSunset near sunset — and
      // the bare `>=` chattered ON/OFF every 30 s. Once engaged before sunset it
      // must LATCH ON until the daytime minimum is met.
      vi.setSystemTime(new Date("2026-08-15T20:24:00")); // before sunset, not in an HC slot
      const nearSunset = {
        sunrise: "07:00",
        sunset: "20:48",
        isDaylight: true,
      };
      const { ctx, state, orderCalls, getPumpState } = buildCtx({
        waterTemp: 25,
        sunlight: nearSunset,
        tariff: TARIFF,
      });
      // Crossing: deficit 0.4 h (6 − 5.6) equals hoursUntilSunset (20:48 − 20:24).
      state.set("day", "2026-08-15");
      state.set("targetHours", 11); // still below the daily target → target gate open
      state.set("runSecondsToday", 5.6 * 3600);
      state.set("daytimeSecondsToday", 5.6 * 3600);
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false, daytimeMinHours: 6 },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      // Jitter nudges the deficit just under hoursUntilSunset → pre-fix OFF.
      state.set("daytimeSecondsToday", 5.61 * 3600 + 40);
      await vi.advanceTimersByTimeAsync(3 * 30_000);
      expect(orderCalls.filter((c) => c.value === "OFF")).toHaveLength(0);
      expect(getPumpState()).toBe("ON");
      handle.stop();
    });

    it("generic tariff: a midday-only off-peak contract runs the pump midday (no night assumption)", () => {
      // Off-peak read from the contract, whenever it falls — here 11:00-16:00.
      vi.setSystemTime(new Date("2026-08-06T12:00:00"));
      const middayHc = {
        configured: true,
        offPeakToday: [{ start: "11:00", end: "16:00" }],
        isOffPeakNow: null,
      };
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: middayHc,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      }); // via midday off-peak
      handle.stop();
    });

    it("stops once the daily target is reached", async () => {
      vi.setSystemTime(new Date("2026-08-06T18:00:00")); // near sunset → floor drives it ON
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 30,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        {
          ...AUTO,
          runOnSurplus: false,
          maxFiltrationHours: 1,
          filtrationRefTemp: 30,
          minFiltrationHours: 0,
        },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      await vi.advanceTimersByTimeAsync(65 * 60_000); // > 1 h target → OFF
      expect(
        orderCalls.filter((c) => c.value === "OFF").length,
      ).toBeGreaterThanOrEqual(1);
      handle.stop();
    });

    it("target below the daytime minimum wins: the pump caps at target, not the floor", async () => {
      // daytimeMinHours (5) deliberately exceeds the temperature-derived target (2 h).
      // The target gate is master: the pump stops at 2 h and does NOT run the 5 h floor.
      vi.setSystemTime(new Date("2026-08-06T17:00:00")); // floor-fire time, target met before sunset
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 30,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        {
          ...AUTO,
          runOnSurplus: false,
          maxFiltrationHours: 2,
          filtrationRefTemp: 30,
          minFiltrationHours: 0,
          daytimeMinHours: 5,
        },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      }); // floor fires
      await vi.advanceTimersByTimeAsync(2 * 3600_000 + 5 * 60_000); // just past the 2 h target
      expect(
        orderCalls.filter((c) => c.value === "OFF").length,
      ).toBeGreaterThanOrEqual(1); // capped at target
      handle.stop();
    });

    it("finalises yesterday's average water temp at the 06:00 filtration-day boundary", async () => {
      vi.setSystemTime(new Date("2026-08-06T04:30:00")); // pre-dawn = previous filtration day
      const { ctx, state } = buildCtx({
        waterTemp: 22,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false, minFiltrationHours: 0 },
        ctx as never,
      );
      // 04:30 night safety net → pump runs, sampling 22 °C; cross the 06:00 boundary.
      await vi.advanceTimersByTimeAsync(2 * 3600_000); // to 06:30
      expect(state.get("waterTempYesterday")).toBe(22);
      expect(state.get("targetHours")).toBe(8.8); // 22 * 12/30
      handle.stop();
    });

    it("no arbiter on the core: off-peak/daytime/deadline rules still drive, no crash", () => {
      vi.setSystemTime(new Date("2026-08-06T15:00:00")); // inside the 14:34-17:04 off-peak slot
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      }); // no energy
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: true }, // requested, but no arbiter → falls back to off-peak
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("optional fixed windows still force the pump on in auto mode", () => {
      vi.setSystemTime(new Date("2026-08-06T21:30:00")); // evening, no auto rule active
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        {
          ...AUTO,
          runOnSurplus: false,
          slot1_start: "21:00",
          slot1_end: "22:00",
        },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("logs its decision with the rule and progress (audit trail)", async () => {
      vi.setSystemTime(new Date("2026-08-06T20:30:00")); // only surplus can run it (8 h target)
      const arb = makeArbiter();
      const { ctx, logLines } = buildCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: true },
        ctx as never,
      );
      arb.grant();
      await vi.advanceTimersByTimeAsync(1);
      expect(logLines.some((l) => l.includes("Surplus solaire accordé"))).toBe(
        true,
      );
      expect(
        logLines.some(
          (l) => l.includes("→ ON via surplus") && l.includes("/8.0 h"),
        ),
      ).toBe(true);
      handle.stop();
    });

    it("names the rule for an HC transition driven by the 30 s tick (audit)", async () => {
      // sunset 13:00 → 14:xx is not daytime, isolating the HC rule; start just before it.
      vi.setSystemTime(new Date("2026-08-06T14:30:00"));
      const { ctx, logLines } = buildCtx({
        waterTemp: 20,
        sunlight: { sunrise: "07:00", sunset: "13:00", isDaylight: true },
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      await vi.advanceTimersByTimeAsync(6 * 60_000); // cross into the 14:34 HC slot
      expect(logLines.some((l) => l.includes("→ ON via heures creuses"))).toBe(
        true,
      );
      handle.stop();
    });

    it("degrades safely on garbled tariff/sunlight helper output (no crash)", () => {
      vi.setSystemTime(new Date("2026-08-06T19:00:00")); // near the fallback sunset (20:00) → floor due
      const { ctx, orderCalls } = buildCtx({
        waterTemp: 25,
        sunlight: { sunrise: 700, sunset: null, isDaylight: null }, // numeric/null → fallback 08:00-20:00
        tariff: {
          configured: true,
          offPeakToday: undefined,
          isOffPeakNow: null,
        }, // not an array
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      expect(orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      }); // daytime floor
      handle.stop();
    });

    it("degrades safely when tariff/sunlight helpers THROW (no crash)", () => {
      vi.setSystemTime(new Date("2026-08-06T19:00:00")); // near the fallback sunset → floor due
      const b = buildCtx({ waterTemp: 25 });
      (b.ctx.helpers as Record<string, unknown>).getTariff = () => {
        throw new Error("boom");
      };
      (b.ctx.helpers as Record<string, unknown>).getSunlight = () => {
        throw new Error("boom");
      };
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        b.ctx as never,
      );
      // daytimeMin/inHcSlot catch internally → fallback daytime → floor → ON, no throw.
      expect(b.orderCalls).toContainEqual({
        equipmentId: "P1",
        alias: "state",
        value: "ON",
      });
      handle.stop();
    });

    it("bare auto: a manual order latches a dérogation that lifts at the next auto transition", async () => {
      // sunset 13:00 so 14:30 is OFF (no HC yet, no daylight, no surplus) → no edge until HC.
      vi.setSystemTime(new Date("2026-08-06T14:30:00"));
      const { ctx, state, emit, setPumpState } = buildCtx({
        waterTemp: 25,
        sunlight: { sunrise: "07:00", sunset: "13:00", isDaylight: true },
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false },
        ctx as never,
      );
      // Bare auto has NO window edges — a manual order must still be recoverable.
      emit("equipment.order.executed", {
        equipmentId: "P1",
        orderAlias: "state",
        source: { kind: "manual", userId: "u1" },
      });
      setPumpState("ON");
      expect(state.get("override")).toBe(true);
      await vi.advanceTimersByTimeAsync(6 * 60_000); // cross into the 14:34 HC slot → auto transition
      expect(state.get("override")).toBe(false); // dérogation lifted
      handle.stop();
    });

    it("bare auto: a dérogation taken under an active grant still stands", async () => {
      // The counterpart of #24: a GENUINE manual order must keep standing.
      // The core arbiter suspends the equipment for `overrideTtlS` (2 h) on
      // that same order, so any escape hatch that lifted the dérogation on
      // surplus would only get its claim denied "override-active" — and undo
      // the user's choice on the way. The ladder must simply not move.
      vi.setSystemTime(new Date("2026-08-06T17:30:00"));
      const arb = makeArbiter();
      const { ctx, state, emit, setPumpState } = buildCtx({
        waterTemp: 25,
        energy: arb.energy,
        sunlight: { sunrise: "07:00", sunset: "13:00", isDaylight: false },
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: true },
        ctx as never,
      );
      arb.grant();
      await vi.advanceTimersByTimeAsync(6_000); // past the own-order grace
      emit("equipment.order.executed", {
        equipmentId: "P1",
        orderAlias: "state",
        source: { kind: "manual", userId: "u1" },
      });
      setPumpState("OFF");
      expect(state.get("override")).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(state.get("override")).toBe(true); // held: no ladder movement
      handle.stop();
    });

    it("bare auto: the 06:00 rollover lifts a lingering dérogation (backstop)", async () => {
      vi.setSystemTime(new Date("2026-08-06T23:00:00"));
      const { ctx, state, emit, setPumpState } = buildCtx({
        waterTemp: 25,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(
        { ...AUTO, runOnSurplus: false, minFiltrationHours: 0 },
        ctx as never,
      );
      // Startup dispatches ON (nightCatchUp) — step past the own-order grace so
      // the manual order below is not mistaken for the recipe's own dispatch.
      await vi.advanceTimersByTimeAsync(6_000);
      emit("equipment.order.executed", {
        equipmentId: "P1",
        orderAlias: "state",
        source: { kind: "manual", userId: "u1" },
      });
      setPumpState("OFF");
      expect(state.get("override")).toBe(true);
      await vi.advanceTimersByTimeAsync(7.5 * 3600_000); // past the 06:00 boundary
      expect(state.get("override")).toBe(false);
      handle.stop();
    });
  });
});

// ============================================================
// Surplus heating (v1.5.0)
// ============================================================

describe("surplus heating (v1.5.0)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SUN = { sunrise: "07:00", sunset: "20:00", isDaylight: true };
  const TARIFF = {
    configured: true,
    offPeakToday: [
      { start: "00:04", end: "05:34" },
      { start: "14:34", end: "17:04" },
    ],
    isOffPeakNow: null,
  };
  // Auto mode, pump surplus off to isolate the heater claim. 20:30, past
  // sunset, outside HC, deadline still slack → only a heater grant can run.
  const HEAT = {
    zone: "Z1",
    pump: "P1",
    waterTempSensor: "WT1",
    runOnSurplus: false,
    heater: "HP1",
    heatingTargetTemp: 28,
    heaterIdleSetpoint: 10,
  };
  const T2030 = new Date("2026-08-06T20:30:00");

  type ClaimReq = {
    equipmentId: string;
    watts?: number;
    toleratedImportW?: number;
    slack?: string;
    note?: string;
    onGranted: () => void;
    onRevoked: (r: string) => void;
  };

  /** Multi-claim fake arbiter: one record per equipmentId. */
  function makeArbiterMulti(opts?: { enabled?: boolean; denied?: string[] }) {
    const recs = new Map<string, { status: string; req: ClaimReq }>();
    const reqs: ClaimReq[] = [];
    /** Spec 166 — every `reportNeed` value pushed, per equipmentId. */
    const needs = new Map<string, boolean[]>();
    return {
      energy: {
        claimCapacity: (r: ClaimReq) => {
          const denied = opts?.denied?.includes(r.equipmentId) ?? false;
          const rec = { status: denied ? "denied" : "pending", req: r };
          recs.set(r.equipmentId, rec);
          reqs.push(r);
          return {
            id: r.equipmentId,
            status: () => rec.status,
            deniedReason: denied ? "not-profiled" : undefined,
            release: () => {
              rec.status = "released";
            },
            // Spec 166 — a core carrying the spec exposes this. It records
            // ONLY while the claim is granted, mirroring the real arbiter
            // (`if (record.status !== "granted") return`): a fake that accepted
            // a declaration on a pending claim would let a test assert a value
            // the engine throws away.
            reportNeed: (need: boolean) => {
              if (rec.status !== "granted") return;
              const list = needs.get(r.equipmentId) ?? [];
              list.push(need);
              needs.set(r.equipmentId, list);
            },
          };
        },
        getCapacityState: () => ({
          enabled: opts?.enabled ?? true,
          availableSurplusW: 1500,
          grants: [],
        }),
      },
      reqs,
      active: (eq: string) => {
        const r = recs.get(eq);
        return !!r && (r.status === "pending" || r.status === "granted");
      },
      grant: (eq: string) => {
        const r = recs.get(eq);
        if (r && r.status === "pending") {
          r.status = "granted";
          r.req.onGranted();
        }
      },
      revoke: (eq: string) => {
        const r = recs.get(eq);
        if (r && r.status === "granted") {
          r.status = "pending";
          r.req.onRevoked("surplus-deficit");
        }
      },
      /** Spec 166 — the last need declared for a load, or null if never. */
      lastNeed: (eq: string) => {
        const l = needs.get(eq);
        return l && l.length ? l[l.length - 1] : null;
      },
      needCount: (eq: string) => (needs.get(eq) ?? []).length,
    };
  }

  /** buildCtx + a heater HP1 exposing a setpoint binding that follows orders. */
  function buildHeatCtx(
    opts: Parameters<typeof buildCtx>[0] & {
      initialSetpoint?: number;
      profiles?: Record<string, number>;
    } = {},
  ) {
    const base = buildCtx(opts);
    let heaterSetpoint: unknown = opts.initialSetpoint ?? 10;
    const em = base.ctx.equipmentManager as {
      getById: (id: string) => unknown;
      getDataBindingsWithValues: (
        id: string,
      ) => Array<{ alias: string; value: unknown }>;
    };
    const origBindings = em.getDataBindingsWithValues.bind(em);
    em.getDataBindingsWithValues = (id: string) =>
      id === "HP1"
        ? [{ alias: "setpoint", value: heaterSetpoint }]
        : origBindings(id);
    if (opts.profiles) {
      em.getById = (id: string) => ({
        id,
        name: id,
        type: "x",
        ...(opts.profiles![id]
          ? { energyProfile: { nominalPowerW: opts.profiles![id] } }
          : {}),
      });
    }
    const origDispatch = base.ctx.dispatchOrder.bind(base.ctx);
    (base.ctx as { dispatchOrder: unknown }).dispatchOrder = async (
      e: string,
      a: string,
      v: unknown,
    ) => {
      if (e === "HP1" && a === "setpoint") heaterSetpoint = v;
      return origDispatch(e, a, v);
    };
    return { ...base, getSetpoint: () => heaterSetpoint };
  }

  const setpointCalls = (calls: OrderCall[]) =>
    calls.filter((c) => c.equipmentId === "HP1" && c.alias === "setpoint");

  it("validate: a heater requires a water temperature sensor", () => {
    const recipe = createRecipe();
    const { ctx } = buildCtx();
    expect(() =>
      recipe.validate({ zone: "Z1", pump: "P1", heater: "HP1" }, ctx as never),
    ).toThrow(/water temperature sensor/);
  });

  it("validate: the heating target must be above the idle setpoint", () => {
    const recipe = createRecipe();
    const { ctx } = buildCtx();
    expect(() =>
      recipe.validate(
        { ...HEAT, heatingTargetTemp: 12, heaterIdleSetpoint: 15 },
        ctx as never,
      ),
    ).toThrow(/above the idle setpoint/);
  });

  it("claims for the heater with slack high and no recipe-level tolerance (profile drives it, #14) once the pump is granted; the pump also claims for the water flow", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    // The pump claims immediately in its OWN name (heating needs water flow);
    // the heater only claims once the pump holds its own surplus grant (#564).
    expect(arb.active("P1")).toBe(true);
    expect(arb.active("HP1")).toBe(false);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1); // the tick claims the heater on top
    expect(arb.active("HP1")).toBe(true);
    const req = arb.reqs.find((r) => r.equipmentId === "HP1")!;
    expect(req.slack).toBe("high");
    // The claim no longer carries a tolerance; the arbiter resolves it from the
    // heater equipment's energyProfile.toleratedImportW (core #550).
    expect(req.toleratedImportW).toBeUndefined();
    expect(req.watts).toBeUndefined(); // no energy profiles exposed
    handle.stop();
  });

  it("each load declares only its own watts (no bundling)", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
      profiles: { P1: 600, HP1: 2000 },
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1"); // the heater only claims once the pump holds its grant (#564)
    await vi.advanceTimersByTimeAsync(1);
    const heaterReq = arb.reqs.find((r) => r.equipmentId === "HP1")!;
    const pumpReq = arb.reqs.find((r) => r.equipmentId === "P1")!;
    expect(heaterReq.watts).toBe(2000); // heater's own nominal, NOT pump + heater
    // The pump's own claim carries its own watts (or the arbiter's nominal
    // fallback); the point is the 600 W is never double-counted on the heater.
    expect(heaterReq.watts).not.toBe(2600);
    expect(arb.active("P1")).toBe(true);
    expect(pumpReq).toBeDefined();
    handle.stop();
  });

  it("grant → pump ON first, then setpoint raised to the target; startup keeps it idle", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, orderCalls } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    // Startup: no grant, binding already at idle (seeded) → nothing to send.
    expect(setpointCalls(orderCalls)).toHaveLength(0);
    expect(
      orderCalls.filter((c) => c.alias === "state" && c.value === "ON"),
    ).toHaveLength(0);
    // The pump is granted first; the heater claims on top. The pump only turns
    // ON once the heater is granted too, then the setpoint is raised (#564).
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    const on = orderCalls.findIndex(
      (c) => c.alias === "state" && c.value === "ON",
    );
    const hot = orderCalls.findIndex(
      (c) => c.alias === "setpoint" && c.value === 28,
    );
    expect(on).toBeGreaterThan(-1);
    expect(hot).toBeGreaterThan(on); // water flows before the heater is asked to heat
    handle.stop();
  });

  it("revoke → setpoint lowered BEFORE the pump OFF", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, orderCalls } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    arb.revoke("HP1");
    await vi.advanceTimersByTimeAsync(1);
    const idle = orderCalls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.alias === "setpoint" && c.value === 10);
    const off = orderCalls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.alias === "state" && c.value === "OFF");
    expect(idle.length).toBeGreaterThan(0); // the revoke path
    expect(off.length).toBeGreaterThan(0);
    expect(idle[idle.length - 1].i).toBeLessThan(off[off.length - 1].i);
    handle.stop();
  });

  it("#564 — pump revoked ⇒ heater released and idled, even inside the heater's own minOn", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, getSetpoint } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28); // heating engaged
    expect(arb.active("HP1")).toBe(true);

    // The arbiter sheds the PUMP (e.g. the heater's own claim is still shielded
    // by its minOn). The PAC cannot circulate its own water: the recipe must
    // release the heater and idle the setpoint rather than heat dry.
    arb.revoke("P1");
    await vi.advanceTimersByTimeAsync(1);
    expect(arb.active("HP1")).toBe(false); // leaves "accordé" in the arbiter
    expect(getSetpoint()).toBe(10);

    // And it must not immediately re-claim while the pump holds no grant.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("HP1")).toBe(false);
    handle.stop();
  });

  /** Multi-claim fake arbiter whose signed surplus is settable (#22). */
  function makeArbiterSurplus(initialSurplus: number) {
    let surplus = initialSurplus;
    let claims = 0; // every claimCapacity() call, to pin "no re-claim" (#23)
    const recs = new Map<string, { status: string; req: ClaimReq }>();
    return {
      energy: {
        claimCapacity: (r: ClaimReq) => {
          claims += 1;
          const rec = { status: "pending", req: r };
          recs.set(r.equipmentId, rec);
          return {
            id: r.equipmentId,
            status: () => rec.status,
            deniedReason: undefined,
            release: () => {
              rec.status = "released";
            },
          };
        },
        getCapacityState: () => ({
          enabled: true,
          availableSurplusW: surplus,
          grants: [],
        }),
      },
      setSurplus: (w: number) => {
        surplus = w;
      },
      claimCount: () => claims,
      active: (eq: string) => {
        const r = recs.get(eq);
        return !!r && (r.status === "pending" || r.status === "granted");
      },
      grant: (eq: string) => {
        const r = recs.get(eq);
        if (r && r.status === "pending") {
          r.status = "granted";
          r.req.onGranted();
        }
      },
      // Mirrors the real arbiter: a revoke returns the claim to `pending`
      // (capacity-arbiter `revoke()`), it does NOT end it. Only a claimant's
      // own `release()` is terminal. A fake that terminated on revoke would
      // let a test assert an ending the engine never produces.
      revoke: (eq: string) => {
        const r = recs.get(eq);
        if (r && r.status === "granted") {
          r.status = "pending";
          r.req.onRevoked("surplus-deficit");
        }
      },
    };
  }

  it("#22 — a sustained deficit does NOT release the heater; the arbiter's revoke does", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterSurplus(1500); // heating on surplus
    const { ctx, getSetpoint } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28); // heating engaged
    expect(arb.active("HP1")).toBe(true);

    // The home is importing, and stays importing well past the ~3 min debounce
    // v1.6.3 used to release on. The recipe must NOT act on that: while its
    // claim is granted, whether the surplus still covers it is the arbiter's
    // question. Holding the claim is what lets the arbiter journal a real
    // `revoked` (red on the timeline, counted as a short cycle, `minOffS`
    // armed) instead of a mute recipe-side `released`.
    arb.setSurplus(-700);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(arb.active("HP1")).toBe(true);
    expect(getSetpoint()).toBe(28);

    // The arbiter is the one that ends it: the setpoint idles at once.
    const claimsBefore = arb.claimCount();
    arb.revoke("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(10);
    // ...but the claim SURVIVES, back to pending, exactly as the engine leaves
    // it. The recipe still wants surplus; it is simply not being served.
    expect(arb.active("HP1")).toBe(true);

    // And when the arbiter serves it again (its own `minOffS` having elapsed),
    // heating resumes on the SAME claim — the recipe never re-claims.
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28);
    expect(arb.claimCount()).toBe(claimsBefore);
    handle.stop();
  });

  it("water at target → claim released, setpoint idles, and 0.5 °C hysteresis re-engages", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, setWaterTemp, getSetpoint } = buildHeatCtx({
      waterTemp: 27,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28);
    setWaterTemp(28.1); // target reached
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("HP1")).toBe(false);
    expect(getSetpoint()).toBe(10);
    setWaterTemp(27.8); // inside the hysteresis band → stays satisfied
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("HP1")).toBe(false);
    setWaterTemp(27.4); // below target - 0.5 → wanted again
    await vi.advanceTimersByTimeAsync(30_000);
    // The pump re-claims; once it is granted again the heater claims on top (#564).
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    expect(arb.active("HP1")).toBe(true);
    handle.stop();
  });

  it("pump claim tracks the heater: taken while heating, released when it stops, re-taken", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, setWaterTemp } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    // runOnSurplus is off, yet the pump claims in its own name because heating
    // needs water flow — this is what keeps it green on the timeline.
    expect(arb.active("P1")).toBe(true);
    setWaterTemp(28.1); // target reached → heating no longer needed
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("P1")).toBe(false); // the heating-driven claim is released, not leaked
    setWaterTemp(27.4); // below target - 0.5 → heating wanted again
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("P1")).toBe(true); // re-taken
    handle.stop();
  });

  it("manual setpoint change → dérogation until the filtration-day rollover", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, state, emit } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1"); // pump granted so the heater claims (#564)
    await vi.advanceTimersByTimeAsync(1);
    expect(arb.active("HP1")).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000); // past the own-order grace
    emit("equipment.order.executed", {
      equipmentId: "HP1",
      orderAlias: "setpoint",
      source: { kind: "manual", userId: "u1" },
    });
    expect(state.get("heaterOverride")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arb.active("HP1")).toBe(false); // claim released under dérogation
    await vi.advanceTimersByTimeAsync(10 * 3600_000); // past the 06:00 boundary
    expect(state.get("heaterOverride")).toBe(false);
    expect(arb.active("HP1")).toBe(true); // heating resumes the next day (pump still granted)
    handle.stop();
  });

  it("a delivery-retry replay of a setpoint is not a manual change (#24)", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, state, emit } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(6_000); // past the own-order grace
    emit("equipment.order.executed", {
      equipmentId: "HP1",
      orderAlias: "setpoint",
      source: { kind: "external", channel: "delivery-retry" },
    });
    expect(state.get("heaterOverride")).not.toBe(true);
    handle.stop();
  });

  it("denied not-profiled → a single explanatory warn, then keeps retrying quietly", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti({ denied: ["HP1"] });
    const { ctx, logLines } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1"); // pump granted so the heater attempts its (denied) claim (#564)
    await vi.advanceTimersByTimeAsync(120_000); // ticks inside the backoff window
    expect(arb.reqs.filter((r) => r.equipmentId === "HP1")).toHaveLength(1); // no journal spam
    await vi.advanceTimersByTimeAsync(16 * 60_000); // past the 15 min denied backoff
    const warns = logLines.filter((l) => l.includes("profil énergie"));
    expect(warns).toHaveLength(1);
    expect(
      arb.reqs.filter((r) => r.equipmentId === "HP1").length,
    ).toBeGreaterThan(1);
    handle.stop();
  });

  it("manual dérogation survives the pump OFF: the recipe never clobbers the user's setpoint", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, state, emit, orderCalls, getSetpoint } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28); // heating engaged
    await vi.advanceTimersByTimeAsync(6_000); // past the own-order grace
    emit("equipment.order.executed", {
      equipmentId: "HP1",
      orderAlias: "setpoint",
      source: { kind: "manual", userId: "u1" },
    });
    expect(state.get("heaterOverride")).toBe(true);
    const setpointsBefore = setpointCalls(orderCalls).length;
    await vi.advanceTimersByTimeAsync(61_000); // claim released → pump transitions OFF
    expect(
      orderCalls.some((c) => c.alias === "state" && c.value === "OFF"),
    ).toBe(true);
    // The pre-OFF setpoint lowering must NOT fire under the dérogation.
    expect(setpointCalls(orderCalls)).toHaveLength(setpointsBefore);
    expect(getSetpoint()).toBe(28); // the user's value stands
    handle.stop();
  });

  it("restart mid-heating: startup lowers the setpoint BEFORE the corrective pump OFF", () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, state, orderCalls } = buildHeatCtx({
      waterTemp: 20,
      initialPumpState: "ON", // engine restarted while the pump was heating
      initialSetpoint: 28,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    // Persisted state says the filtration target is already met → the startup
    // reconcile wants the pump OFF immediately.
    state.set("day", "2026-08-06");
    state.set("runSecondsToday", 9 * 3600); // above the 8 h target (water 20)
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    const idle = orderCalls.findIndex(
      (c) => c.alias === "setpoint" && c.value === 10,
    );
    const off = orderCalls.findIndex(
      (c) => c.alias === "state" && c.value === "OFF",
    );
    expect(idle).toBeGreaterThan(-1);
    expect(off).toBeGreaterThan(-1);
    expect(idle).toBeLessThan(off); // heater calmed before its water flow stops
    handle.stop();
  });

  it("without a heater slot nothing changes: no HP1 claim, no setpoint order", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, orderCalls } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(
      { zone: "Z1", pump: "P1", waterTempSensor: "WT1", runOnSurplus: false },
      ctx as never,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(arb.reqs).toHaveLength(0);
    expect(setpointCalls(orderCalls)).toHaveLength(0);
    handle.stop();
  });

  it("stop() while heating → setpoint lowered, then pump OFF", async () => {
    vi.setSystemTime(T2030);
    const arb = makeArbiterMulti();
    const { ctx, orderCalls, getSetpoint } = buildHeatCtx({
      waterTemp: 20,
      energy: arb.energy,
      sunlight: SUN,
      tariff: TARIFF,
    });
    const handle = createRecipe().createInstance(HEAT, ctx as never);
    arb.grant("P1");
    await vi.advanceTimersByTimeAsync(1);
    arb.grant("HP1");
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(28);
    handle.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(getSetpoint()).toBe(10);
    const idleIdx = orderCalls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.alias === "setpoint" && c.value === 10);
    const offIdx = orderCalls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.alias === "state" && c.value === "OFF");
    expect(idleIdx[idleIdx.length - 1].i).toBeLessThan(
      offIdx[offIdx.length - 1].i,
    );
    expect(arb.active("HP1")).toBe(false);
  });
  describe("reportNeed (spec 166)", () => {
    it("declares the heater at rest in the 'attente pompe' window", async () => {
      // Both claims are granted and the PAC's 1800 W are reserved, but the pump
      // is not observed running, so `heaterEngaged()` is false, the setpoint
      // stays parked at idle and the machine draws nothing. This is the window
      // the recipe already names in its own state, and the one the declaration
      // exists to describe: without it the arbitration surface shows solid
      // green with nothing behind it.
      vi.setSystemTime(T2030);
      const arb = makeArbiterMulti();
      const { ctx, state, setPumpState } = buildHeatCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(HEAT, ctx as never);
      arb.grant("P1");
      await vi.advanceTimersByTimeAsync(1);
      arb.grant("HP1");
      await vi.advanceTimersByTimeAsync(1);
      expect(arb.lastNeed("HP1")).toBe(true);

      // The pump stops being observed running (breaker, offline device, a stop
      // that has not been ordered by us).
      setPumpState("OFF");
      await vi.advanceTimersByTimeAsync(31_000);

      expect(state.get("heating")).toBe("attente pompe");
      expect(arb.lastNeed("HP1")).toBe(false);
      handle.stop();
    });

    it("declares the pump at rest when it is commanded ON but not running", async () => {
      // Intent alone would keep saying "drawing" on a pump whose breaker is
      // off, on a load that is reserving watts and consuming nothing. The
      // observed state vetoes the intent once the own-order grace has passed.
      vi.setSystemTime(T2030);
      const arb = makeArbiterMulti();
      const { ctx, setPumpState } = buildHeatCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(HEAT, ctx as never);
      arb.grant("P1");
      await vi.advanceTimersByTimeAsync(1);
      arb.grant("HP1");
      await vi.advanceTimersByTimeAsync(1);
      expect(arb.lastNeed("P1")).toBe(true);

      setPumpState("OFF");
      await vi.advanceTimersByTimeAsync(31_000);

      expect(arb.lastNeed("P1")).toBe(false);
      handle.stop();
    });

    it("declares both drawing once the heater is granted and the pump runs", async () => {
      vi.setSystemTime(T2030);
      const arb = makeArbiterMulti();
      const { ctx } = buildHeatCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(HEAT, ctx as never);

      arb.grant("P1");
      await vi.advanceTimersByTimeAsync(1);
      arb.grant("HP1");
      await vi.advanceTimersByTimeAsync(1);

      expect(arb.lastNeed("HP1")).toBe(true);
      expect(arb.lastNeed("P1")).toBe(true);
      handle.stop();
    });

    it("releases the heater claim on a pump revoke rather than declaring it at rest", async () => {
      // #564: losing the pump means losing water flow, so the PAC cannot heat.
      // The recipe drops the claim entirely, which is better than holding it
      // and declaring no need: no grant, no reservation standing against a
      // lower-priority load, and the roster shows the PAC leaving "accordé"
      // instead of lingering there in a paler green.
      vi.setSystemTime(T2030);
      const arb = makeArbiterMulti();
      const { ctx } = buildHeatCtx({
        waterTemp: 20,
        energy: arb.energy,
        sunlight: SUN,
        tariff: TARIFF,
      });
      const handle = createRecipe().createInstance(HEAT, ctx as never);
      arb.grant("P1");
      await vi.advanceTimersByTimeAsync(1);
      arb.grant("HP1");
      await vi.advanceTimersByTimeAsync(1);
      expect(arb.lastNeed("HP1")).toBe(true);
      const before = arb.needCount("HP1");

      arb.revoke("P1");
      await vi.advanceTimersByTimeAsync(1);

      expect(arb.active("HP1")).toBe(false);
      expect(arb.needCount("HP1")).toBe(before);
      handle.stop();
    });
  });
});
