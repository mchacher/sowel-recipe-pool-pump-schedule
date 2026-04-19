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

interface EquipmentManager {
  getById(id: string): Equipment | null;
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

function windowLabel(w: Window): string {
  return `${w.start}-${w.end}`;
}

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

      async function fireOn(w: Window): Promise<void> {
        try {
          await ctx.equipmentManager.executeOrder(pumpId, "state", "ON");
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
          await ctx.equipmentManager.executeOrder(pumpId, "state", "OFF");
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);
          ctx.log(`Pompe ${pumpName()} — arrêt créneau ${windowLabel(w)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur OFF pompe ${pumpName()}: ${msg}`, "error");
        }
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

          const wasRunning = ctx.state.get("status") === "running";
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);

          if (wasRunning) {
            // Override: pump stays ON without the recipe to drive it, so we
            // shut it down on disable (explicit dérogation requested in
            // spec 082).
            ctx.equipmentManager
              .executeOrder(pumpId, "state", "OFF")
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
