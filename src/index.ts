/**
 * Sowel Recipe: Pool Pump Schedule
 *
 * Drives a single pool_pump equipment on a fixed daily schedule. Up to
 * three windows per day; each window has a start time and an end time.
 *
 * At each start the recipe fires `executeOrder(pumpId, "state", "ON")`,
 * at each end `executeOrder(pumpId, "state", "OFF")`. End times earlier
 * than the corresponding start time cross midnight naturally —
 * `msUntilTime` schedules each timer independently.
 *
 * Beyond the edges, the recipe reconciles: at instance start, on every
 * pump state report, and on a periodic guard, it compares the observed
 * pump state with what the schedule expects and re-sends the corrective
 * order when they disagree (issue #1 — a lost OFF once left the pump
 * running 15 hours). A manual order from the user (UI, button) sets a
 * dérogation: reconciliation stands down until the next slot edge.
 *
 * Stopping the instance mid-cycle overrides the schedule: the pump
 * receives an explicit OFF and all timers are cancelled.
 */

// ============================================================
// Types (mirrored from Sowel core — recipe plugins don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): RecipeInstanceHandle;
}

interface Equipment {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

interface RecipeStateStore {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

interface EquipmentDataBindingValue {
  alias: string;
  value: unknown;
}

interface EquipmentManager {
  getById(id: string): Equipment | null;
  getDataBindingsWithValues?(id: string): EquipmentDataBindingValue[];
  executeOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

interface RecipeContext {
  eventBus: { onType(type: string, handler: (event: unknown) => void): () => void };
  equipmentManager: EquipmentManager;
  zoneManager: { getById(id: string): unknown | null };
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  state: RecipeStateStore;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: { parseDuration(value: unknown): number };
  /** Order dispatch with recipe source attribution (newer cores). */
  dispatchOrder?(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

// ============================================================
// Slot model
// ============================================================

interface Window {
  index: number; // 1..3
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

// ============================================================
// Helpers
// ============================================================

/** Compute ms from now to the next occurrence of HH:MM local time. */
export function msUntilTime(time: string, now: Date = new Date()): number {
  const [h, m] = time.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** True when `now` falls inside the window; end < start crosses midnight. */
export function isInsideWindow(now: Date, w: Window): boolean {
  const t = minutesOfDay(now);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;
}

/** The window containing `now`, or null when the pump should be off. */
export function activeWindow(now: Date, windows: Window[]): Window | null {
  return windows.find((w) => isInsideWindow(now, w)) ?? null;
}

/** What the schedule expects the pump state to be at `now`. */
export function scheduledState(now: Date, windows: Window[]): "ON" | "OFF" {
  return activeWindow(now, windows) ? "ON" : "OFF";
}

/** Normalize a raw binding value to ON/OFF, null when unreadable. */
export function normalizePumpState(value: unknown): "ON" | "OFF" | null {
  if (value === "ON" || value === "on" || value === true) return "ON";
  if (value === "OFF" || value === "off" || value === false) return "OFF";
  return null;
}

function windowLabel(w: Window): string {
  return `${w.start}-${w.end}`;
}

/** Periodic reconciliation guard cadence. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Minimum delay between two corrective orders (avoids fighting a dead device). */
const CORRECTION_COOLDOWN_MS = 60_000;
/** Window after an own dispatch during which order events are considered ours. */
const OWN_ORDER_GRACE_MS = 5_000;

function buildWindows(params: Record<string, unknown>): Window[] {
  const windows: Window[] = [];
  for (const n of [1, 2, 3]) {
    const start = params[`slot${n}_start`];
    const end = params[`slot${n}_end`];
    if (isValidHHMM(start) && isValidHHMM(end)) {
      windows.push({ index: n, start, end });
    }
  }
  return windows;
}

// ============================================================
// Slot definitions
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    // Zone — required for UI scoping (recipes are listed per zone). Also
    // used as the default hint for picking the pump.
    {
      id: "zone",
      name: "Zone",
      description: "Zone the pool pump belongs to",
      type: "zone",
      required: true,
    },
    {
      id: "pump",
      name: "Pool pump",
      description: "Pump to drive on/off",
      type: "equipment",
      required: true,
      constraints: { equipmentType: "pool_pump" },
    },

    // Slot 1 — required
    {
      id: "slot1_start",
      name: "Start",
      description: "Start time",
      type: "time",
      required: true,
      group: "slot1",
    },
    {
      id: "slot1_end",
      name: "End",
      description: "End time",
      type: "time",
      required: true,
      group: "slot1",
    },

    // Slot 2 — optional pair
    {
      id: "slot2_start",
      name: "Start",
      description: "Start time",
      type: "time",
      required: false,
      group: "slot2",
    },
    {
      id: "slot2_end",
      name: "End",
      description: "End time",
      type: "time",
      required: false,
      group: "slot2",
    },

    // Slot 3 — optional pair
    {
      id: "slot3_start",
      name: "Start",
      description: "Start time",
      type: "time",
      required: false,
      group: "slot3",
    },
    {
      id: "slot3_end",
      name: "End",
      description: "End time",
      type: "time",
      required: false,
      group: "slot3",
    },
  ];
}

// ============================================================
// i18n
// ============================================================

const FR: RecipeLangPack = {
  name: "Programmation pompe piscine",
  description: "Plages horaires on/off pour la pompe de piscine — jusqu'à 3 créneaux par jour",
  slots: {
    zone: { name: "Zone", description: "Zone de la pompe" },
    pump: { name: "Pompe de piscine", description: "Pompe à piloter" },
    slot1_start: { name: "Début", description: "Heure de mise en marche" },
    slot1_end: { name: "Fin", description: "Heure d'arrêt" },
    slot2_start: { name: "Début", description: "Heure de mise en marche" },
    slot2_end: { name: "Fin", description: "Heure d'arrêt" },
    slot3_start: { name: "Début", description: "Heure de mise en marche" },
    slot3_end: { name: "Fin", description: "Heure d'arrêt" },
  },
  groups: {
    slot1: "Créneau 1",
    slot2: "Créneau 2",
    slot3: "Créneau 3",
  },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "pool-pump-schedule",
    name: "Pool Pump Schedule",
    description: "Scheduled on/off for a pool pump — up to 3 daily time windows",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params) {
      if (!params.zone) {
        throw new Error("Zone is required");
      }
      if (!params.pump) {
        throw new Error("Pool pump is required");
      }

      // Slot 1 must be complete.
      if (!params.slot1_start || !params.slot1_end) {
        throw new Error("Slot 1 start and end are required");
      }

      // Slots 2 and 3: start and end come as a pair.
      for (const n of [2, 3]) {
        const start = params[`slot${n}_start`];
        const end = params[`slot${n}_end`];
        if (start && !end) {
          throw new Error(`Slot ${n} end is required when start is set`);
        }
        if (end && !start) {
          throw new Error(`Slot ${n} start is required when end is set`);
        }
      }

      // Every configured window must have start != end.
      for (const n of [1, 2, 3]) {
        const start = params[`slot${n}_start`];
        const end = params[`slot${n}_end`];
        if (start && end && start === end) {
          throw new Error(`Slot ${n} start and end must differ`);
        }
      }
    },

    createInstance(params, ctx) {
      const pumpId = String(params.pump);
      const windows = buildWindows(params);

      const pumpName = (): string =>
        ctx.equipmentManager.getById(pumpId)?.name ?? pumpId.slice(0, 8);

      const startTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const endTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const unsubs: Array<() => void> = [];
      let reconcileTimer: ReturnType<typeof setInterval> | null = null;
      let lastOwnDispatch = 0;
      let lastCorrection = 0;

      async function sendOrder(value: "ON" | "OFF"): Promise<void> {
        lastOwnDispatch = Date.now();
        if (ctx.dispatchOrder) {
          await ctx.dispatchOrder(pumpId, "state", value);
        } else {
          await ctx.equipmentManager.executeOrder(pumpId, "state", value);
        }
      }

      function setIfChanged(key: string, value: unknown): void {
        if (ctx.state.get(key) !== value) ctx.state.set(key, value);
      }

      async function fireOn(w: Window): Promise<void> {
        try {
          setIfChanged("override", false);
          await sendOrder("ON");
          ctx.state.set("status", "running");
          ctx.state.set("currentSlot", windowLabel(w));
          ctx.log(`Pompe ${pumpName()} — démarrage créneau ${windowLabel(w)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur ON pompe ${pumpName()}: ${msg}`, "error");
        }
      }

      async function fireOff(w: Window): Promise<void> {
        try {
          setIfChanged("override", false);
          await sendOrder("OFF");
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);
          ctx.log(`Pompe ${pumpName()} — arrêt créneau ${windowLabel(w)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur OFF pompe ${pumpName()}: ${msg}`, "error");
        }
      }

      /** Observed pump state, null when the core cannot expose it. */
      function readPumpState(): "ON" | "OFF" | null {
        const bindings = ctx.equipmentManager.getDataBindingsWithValues?.(pumpId);
        const binding = bindings?.find((b) => b.alias === "state");
        return binding ? normalizePumpState(binding.value) : null;
      }

      function syncStateLabels(now: Date): void {
        const w = activeWindow(now, windows);
        if (w) {
          setIfChanged("status", "running");
          setIfChanged("currentSlot", windowLabel(w));
        } else {
          setIfChanged("status", "idle");
          setIfChanged("currentSlot", null);
        }
      }

      /**
       * Compare the observed pump state with what the schedule expects and
       * re-send the corrective order on mismatch. Stands down while a manual
       * dérogation is active (cleared at the next slot edge).
       */
      function reconcile(reason: string): void {
        if (ctx.state.get("override") === true) return;
        const actual = readPumpState();
        if (actual === null) return;
        const now = new Date();
        const expected = scheduledState(now, windows);
        if (actual === expected) {
          syncStateLabels(now);
          return;
        }
        if (Date.now() - lastCorrection < CORRECTION_COOLDOWN_MS) return;
        lastCorrection = Date.now();
        ctx.log(
          `Réconciliation (${reason}) — pompe ${pumpName()} ${actual} au lieu de ${expected}, ordre correctif envoyé`,
          "warn",
        );
        sendOrder(expected)
          .then(() => syncStateLabels(new Date()))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`Erreur réconciliation pompe ${pumpName()}: ${msg}`, "error");
          });
      }

      function scheduleStart(w: Window): void {
        const delay = msUntilTime(w.start);
        const timer = setTimeout(() => {
          fireOn(w).catch((err) =>
            ctx.logger.error({ err, slot: w.start }, "Start fire failed"),
          );
          scheduleStart(w); // re-arm for tomorrow
          updateNextLabels();
        }, delay);
        startTimers.set(w.index, timer);
      }

      function scheduleEnd(w: Window): void {
        const delay = msUntilTime(w.end);
        const timer = setTimeout(() => {
          fireOff(w).catch((err) =>
            ctx.logger.error({ err, slot: w.end }, "End fire failed"),
          );
          scheduleEnd(w); // re-arm for tomorrow
          updateNextLabels();
        }, delay);
        endTimers.set(w.index, timer);
      }

      function updateNextLabels(): void {
        if (windows.length === 0) {
          ctx.state.set("nextStart", null);
          ctx.state.set("nextEnd", null);
          return;
        }
        const nextStart = [...windows].sort(
          (a, b) => msUntilTime(a.start) - msUntilTime(b.start),
        )[0].start;
        const nextEnd = [...windows].sort(
          (a, b) => msUntilTime(a.end) - msUntilTime(b.end),
        )[0].end;
        ctx.state.set("nextStart", nextStart);
        ctx.state.set("nextEnd", nextEnd);
      }

      // ── Initialize ──

      ctx.state.set("status", "idle");
      ctx.state.set("currentSlot", null);
      for (const w of windows) {
        scheduleStart(w);
        scheduleEnd(w);
      }
      updateNextLabels();

      // ── Reconciliation wiring (issue #1) ──
      // "override" is deliberately NOT reset here: a manual dérogation
      // persisted before an engine restart keeps standing until the next edge.

      unsubs.push(
        ctx.eventBus.onType("equipment.data.changed", (event) => {
          const ev = event as { equipmentId?: string; alias?: string };
          if (ev.equipmentId !== pumpId || ev.alias !== "state") return;
          reconcile("état pompe");
        }),
      );

      unsubs.push(
        ctx.eventBus.onType("equipment.order.executed", (event) => {
          const ev = event as {
            equipmentId?: string;
            orderAlias?: string;
            source?: { kind?: string };
          };
          if (ev.equipmentId !== pumpId || ev.orderAlias !== "state") return;
          if (ev.source?.kind === "recipe") return;
          if (Date.now() - lastOwnDispatch < OWN_ORDER_GRACE_MS) return;
          if (ctx.state.get("override") !== true) {
            ctx.state.set("override", true);
            ctx.log(
              `Ordre manuel détecté sur ${pumpName()} — dérogation jusqu'au prochain créneau`,
            );
          }
        }),
      );

      reconcileTimer = setInterval(() => reconcile("garde périodique"), RECONCILE_INTERVAL_MS);
      reconcile("démarrage");

      const labels = windows.map(windowLabel).join(", ");
      ctx.log(
        `Recette démarrée — pompe ${pumpName()}, ${windows.length} créneau(x) [${labels}]`,
      );

      return {
        stop(): void {
          for (const t of startTimers.values()) clearTimeout(t);
          for (const t of endTimers.values()) clearTimeout(t);
          startTimers.clear();
          endTimers.clear();
          if (reconcileTimer) clearInterval(reconcileTimer);
          reconcileTimer = null;
          for (const unsub of unsubs) unsub();
          unsubs.length = 0;

          const wasRunning = ctx.state.get("status") === "running";
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);

          if (wasRunning) {
            // Override: pump stays ON without the recipe to drive it, so we
            // shut it down on disable (explicit dérogation requested in
            // spec 082).
            sendOrder("OFF")
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                ctx.log(`Erreur OFF (arrêt recette) ${pumpName()}: ${msg}`, "error");
              });
            ctx.log(`Recette arrêtée — pompe ${pumpName()} coupée (dérogation)`);
          } else {
            ctx.log("Recette arrêtée");
          }
        },
      };
    },
  };
}
