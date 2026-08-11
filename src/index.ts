/**
 * Sowel Recipe: Pool Pump Schedule
 *
 * Drives a single pool_pump equipment on a fixed daily schedule. Up to
 * three windows per day; each window has a start time and an end time.
 *
 * v1.2.0 adds two optional layers on top of the schedule, both inert when
 * unused so schedule-only installs behave exactly as before:
 *  - A water-temperature filtration target: a daily run-time goal computed
 *    linearly from the water temperature (capped, e.g. 12 h at 30 °C), using
 *    yesterday's average because the reading is only valid while the pump
 *    runs. It is displayed on the instance and the pump stops once reached.
 *  - Solar-surplus running (spec 140): while below the target, the recipe
 *    claims capacity from the arbiter and runs on granted surplus. Absent
 *    arbiter or production, this is inert and the schedule stands alone.
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
 * dérogation: reconciliation stands down until the next slot edge, or in
 * auto mode until the next automatic transition or the 06:00 day rollover.
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

// Spec 140 capacity-arbiter helpers, mirrored from core (recipes don't import
// core). Optional at the call site — see the `energy?` helper below.
interface CapacityClaimReq {
  equipmentId: string;
  watts?: number;
  toleratedImportW?: number;
  slack?: "none" | "some" | "high";
  note?: string;
  onGranted: () => void;
  onRevoked: (reason: string) => void;
}
interface CapacityHandle {
  id: string;
  status(): "pending" | "granted" | "denied" | "released";
  deniedReason?: string;
  release(): void;
}
interface EnergyHelpers {
  claimCapacity(req: CapacityClaimReq): CapacityHandle;
  getCapacityState(): {
    enabled: boolean;
    availableSurplusW: number | null;
    grants: Array<{ equipmentId: string; watts: number; sinceIso: string }>;
  };
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
  helpers: {
    parseDuration(value: unknown): number;
    // Spec 138, Sowel >= 1.37.0. Off-peak schedule for the HC catch-up.
    // Absent/unconfigured → no HC awareness (falls back to the daytime floor
    // and the night safety net).
    getTariff?(): {
      configured: boolean;
      offPeakToday: Array<{ start: string; end: string }>;
      isOffPeakNow: boolean | null;
    };
    // Sunlight, for the daytime bias. Absent → a fixed 08:00-20:00 daytime.
    getSunlight?(): { sunrise: string | null; sunset: string | null; isDaylight: boolean | null };
    // Spec 140, Sowel >= 1.39.0. Optional: absent on older cores, and
    // claimCapacity returns a denied handle when the arbiter is off or the
    // home has no production. The recipe then runs its schedule unchanged.
    energy?: EnergyHelpers;
  };
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
  if (typeof time !== "string") return NaN; // defensive: garbled helper output
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

/**
 * Daily filtration target in hours from the water temperature. Linear and
 * capped: `maxHours` is reached at `refTemp` (default 12 h at 30 °C, i.e.
 * temp × 0.4), floored at `minHours`. The classic "temperature / 2" rule is
 * deliberately NOT used — it over-filters (15 h at 30 °C).
 */
export function computeTargetHours(
  tempC: number,
  opts: { maxHours: number; refTemp: number; minHours: number },
): number {
  if (!Number.isFinite(tempC) || opts.refTemp <= 0) return opts.minHours;
  const raw = (tempC * opts.maxHours) / opts.refTemp;
  const clamped = Math.min(opts.maxHours, Math.max(opts.minHours, raw));
  return Math.round(clamped * 10) / 10; // 0.1 h precision
}

/** Read a numeric water temperature (°C) from a binding value, null if unusable. */
export function normalizeTemp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Local calendar day "YYYY-MM-DD" (server TZ) for the daily rollover. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Periodic reconciliation guard cadence. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Accounting + reconcile cadence for the smart-filtration path (runtime and
 *  water-temp sampling, target roll-over, surplus reconciliation). */
const TICK_INTERVAL_MS = 30_000;
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

    // Smart filtration (optional). Setting a water-temperature sensor turns on
    // a daily run-time target, displayed on the instance; the schedule windows
    // then act as catch-up windows toward it and solar surplus runs count too.
    {
      id: "waterTempSensor",
      name: "Water temperature sensor",
      description:
        "Equipment reading the pool water temperature. Set it to enable the daily filtration-time target. The reading is only sampled while the pump runs, so yesterday's average drives today's target.",
      type: "equipment",
      required: false,
      group: "filtration",
    },
    {
      id: "maxFiltrationHours",
      name: "Max filtration hours",
      description: "Daily target cap, reached at the reference temperature (default 12 h)",
      type: "number",
      required: false,
      defaultValue: 12,
      constraints: { min: 1, max: 24 },
      group: "filtration",
    },
    {
      id: "filtrationRefTemp",
      name: "Reference temperature",
      description: "Water temperature (°C) at which the max hours is reached (default 30)",
      type: "number",
      required: false,
      defaultValue: 30,
      constraints: { min: 10, max: 40 },
      group: "filtration",
    },
    {
      id: "minFiltrationHours",
      name: "Min filtration hours",
      description: "Daily target floor whatever the temperature (default 3 h)",
      type: "number",
      required: false,
      defaultValue: 3,
      constraints: { min: 0, max: 24 },
      group: "filtration",
    },
    {
      id: "daytimeMinHours",
      name: "Guaranteed daytime hours",
      description:
        "Minimum hours to run in broad daylight even without solar surplus (may cost peak-tariff energy). Filtration is more effective during the day.",
      type: "number",
      required: false,
      defaultValue: 3,
      constraints: { min: 0, max: 24 },
      group: "filtration",
    },
    {
      id: "runOnSurplus",
      name: "Run on solar surplus",
      description:
        "Run the pump on solar surplus during the day via the surplus arbiter (Sowel 1.39+). Inert if the arbiter is off or the home has no production.",
      type: "boolean",
      required: false,
      defaultValue: true,
      group: "filtration",
    },
    {
      id: "toleratedImportW",
      name: "Partial-surplus tolerance (W)",
      description:
        "Grid import the pump accepts in order to catch a partial surplus (0 = only run on full surplus). Higher means it starts on a smaller surplus.",
      type: "number",
      required: false,
      defaultValue: 300,
      constraints: { min: 0, max: 3000 },
      group: "filtration",
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
  description:
    "Pilotage de pompe de piscine : créneaux horaires quotidiens, cible de temps de filtration selon la température de l'eau (option) et fonctionnement sur surplus solaire (option).",
  slots: {
    zone: { name: "Zone", description: "Zone de la pompe" },
    pump: { name: "Pompe de piscine", description: "Pompe à piloter" },
    slot1_start: { name: "Début", description: "Heure de mise en marche" },
    slot1_end: { name: "Fin", description: "Heure d'arrêt" },
    slot2_start: { name: "Début", description: "Heure de mise en marche" },
    slot2_end: { name: "Fin", description: "Heure d'arrêt" },
    slot3_start: { name: "Début", description: "Heure de mise en marche" },
    slot3_end: { name: "Fin", description: "Heure d'arrêt" },
    waterTempSensor: {
      name: "Sonde température eau",
      description:
        "Équipement lisant la température de l'eau. Renseignez-le pour activer la cible de temps de filtration. La mesure n'est échantillonnée que pompe en marche, donc c'est la moyenne de la veille qui fixe la cible du jour.",
    },
    maxFiltrationHours: {
      name: "Filtration max (h)",
      description: "Plafond de la cible quotidienne, atteint à la température de référence (défaut 12 h)",
    },
    filtrationRefTemp: {
      name: "Température de référence",
      description: "Température de l'eau (°C) à laquelle la filtration max est atteinte (défaut 30)",
    },
    minFiltrationHours: {
      name: "Filtration min (h)",
      description: "Plancher de la cible quotidienne quelle que soit la température (défaut 3 h)",
    },
    daytimeMinHours: {
      name: "Heures garanties en journée",
      description:
        "Minimum d'heures en pleine journée même sans surplus solaire (peut coûter des heures pleines). La filtration est plus efficace le jour.",
    },
    runOnSurplus: {
      name: "Tourner sur surplus solaire",
      description:
        "Fait tourner la pompe sur le surplus solaire en journée via l'arbitre de surplus (Sowel 1.39+). Inactif si l'arbitre est éteint ou sans production.",
    },
    toleratedImportW: {
      name: "Tolérance surplus partiel (W)",
      description:
        "Import réseau que la pompe accepte pour capter un surplus partiel (0 = seulement sur surplus complet). Plus haut = démarre sur un surplus plus faible.",
    },
  },
  groups: {
    slot1: "Créneau 1",
    slot2: "Créneau 2",
    slot3: "Créneau 3",
    filtration: "Filtration intelligente",
  },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "pool-pump-schedule",
    name: "Pool Pump Schedule",
    description:
      "Pool pump control: daily schedule windows, an optional water-temperature filtration-time target, and optional solar-surplus running.",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params) {
      if (!params.zone) {
        throw new Error("Zone is required");
      }
      if (!params.pump) {
        throw new Error("Pool pump is required");
      }

      // In schedule mode (no water-temp sensor) slot 1 is required; in AUTO
      // mode (a water sensor is set) windows are optional — the temperature
      // target drives filtration, so a bare auto config is valid.
      const autoMode = typeof params.waterTempSensor === "string" && !!params.waterTempSensor;
      if (!autoMode && (!params.slot1_start || !params.slot1_end)) {
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

      // Smart filtration: the floor must not exceed the cap.
      const maxH = Number(params.maxFiltrationHours ?? 12);
      const minH = Number(params.minFiltrationHours ?? 3);
      if (Number.isFinite(maxH) && Number.isFinite(minH) && minH > maxH) {
        throw new Error("Min filtration hours must not exceed max filtration hours");
      }
    },

    createInstance(params, ctx) {
      const pumpId = String(params.pump);
      const windows = buildWindows(params);

      // Smart-filtration params (all optional). A water-temperature sensor
      // turns on the daily run-time target; runOnSurplus adds arbiter-driven
      // runs. With neither, this recipe behaves exactly like v1.1.0.
      const waterTempSensorId =
        typeof params.waterTempSensor === "string" && params.waterTempSensor
          ? params.waterTempSensor
          : null;
      const hasTarget = waterTempSensorId !== null;
      const maxHours = Number(params.maxFiltrationHours ?? 12);
      const refTemp = Number(params.filtrationRefTemp ?? 30);
      const minHours = Number(params.minFiltrationHours ?? 3);
      const daytimeMinHours = Number(params.daytimeMinHours ?? 3);
      const runOnSurplus = params.runOnSurplus !== false; // default on in auto mode
      const toleratedImportW = Math.max(0, Number(params.toleratedImportW ?? 300));
      const DAY_START_HOUR = 6; // filtration-day boundary → night falls last (daytime bias)
      const BOOTSTRAP_TEMP = 24; // day-one estimate with no history and no reading

      const waterTempAlias = ((): string => {
        if (!waterTempSensorId) return "temperature";
        const bindings = ctx.equipmentManager.getDataBindingsWithValues?.(waterTempSensorId) ?? [];
        const byCat = (c: string) =>
          bindings.find((b) => (b as { category?: string }).category === c)?.alias;
        return byCat("temperature_water") ?? byCat("temperature") ??
          bindings.find((b) => b.alias === "temperature")?.alias ?? "temperature";
      })();

      const pumpName = (): string =>
        ctx.equipmentManager.getById(pumpId)?.name ?? pumpId.slice(0, 8);

      const num = (v: unknown, d = 0): number =>
        typeof v === "number" && Number.isFinite(v) ? v : d;

      const startTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const endTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const unsubs: Array<() => void> = [];
      let guardTimer: ReturnType<typeof setInterval> | null = null;
      let accountTimer: ReturnType<typeof setInterval> | null = null;
      let lastOwnDispatch = 0;
      let lastCorrection = 0;
      let lastAccountAt: number | null = null;
      let lastAutoDesired: "ON" | "OFF" | null = null; // last auto desired-state, for transition logging
      let stopped = false;

      // Surplus arbiter (spec 140) state.
      let claim: CapacityHandle | null = null;
      let arbiterGranted = false;
      let tickScheduled = false;

      async function sendOrder(value: "ON" | "OFF"): Promise<void> {
        lastOwnDispatch = Date.now();
        if (ctx.dispatchOrder) {
          await ctx.dispatchOrder(pumpId, "state", value);
        } else {
          await ctx.equipmentManager.executeOrder(pumpId, "state", value);
        }
      }

      async function dispatch(value: "ON" | "OFF"): Promise<void> {
        try {
          await sendOrder(value);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur ordre ${value} pompe ${pumpName()}: ${msg}`, "error");
        }
      }

      function setIfChanged(key: string, value: unknown): void {
        if (ctx.state.get(key) !== value) ctx.state.set(key, value);
      }

      /** Observed pump state, null when the core cannot expose it. */
      function readPumpState(): "ON" | "OFF" | null {
        const bindings = ctx.equipmentManager.getDataBindingsWithValues?.(pumpId);
        const binding = bindings?.find((b) => b.alias === "state");
        return binding ? normalizePumpState(binding.value) : null;
      }

      /** Water temperature (°C), null when unavailable — valid only while running. */
      function readWaterTemp(): number | null {
        if (!waterTempSensorId) return null;
        const bindings = ctx.equipmentManager.getDataBindingsWithValues?.(waterTempSensorId);
        const b =
          bindings?.find((x) => x.alias === waterTempAlias) ??
          bindings?.find((x) => x.alias === "temperature");
        return b ? normalizeTemp(b.value) : null;
      }

      // Daylight bounds from the core, with a fixed fallback.
      const daytimeMin = (): { sr: number; ss: number } => {
        try {
          const sun = ctx.helpers.getSunlight?.();
          const parse = (s: unknown, d: number) => {
            if (typeof s !== "string") return d;
            const m = toMinutes(s);
            return Number.isFinite(m) ? m : d;
          };
          return { sr: parse(sun?.sunrise, 8 * 60), ss: parse(sun?.sunset, 20 * 60) };
        } catch {
          return { sr: 8 * 60, ss: 20 * 60 }; // a throwing helper must not break control
        }
      };
      function isDaytime(now: Date): boolean {
        const { sr, ss } = daytimeMin();
        const m = minutesOfDay(now);
        return m >= sr && m <= ss;
      }
      /** Now falls inside a configured off-peak (HC) slot. */
      function inHcSlot(now: Date): boolean {
        try {
          const t = ctx.helpers.getTariff?.();
          if (!t?.configured || !Array.isArray(t.offPeakToday)) return false;
          const m = minutesOfDay(now);
          return t.offPeakToday.some((s) => {
            const a = toMinutes(s?.start);
            const b = toMinutes(s?.end);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
            return a < b ? m >= a && m < b : m >= a || m < b; // handles midnight-crossing
          });
        } catch {
          return false; // a throwing tariff helper must not break control
        }
      }
      /** Filtration-day key: rolls at DAY_START_HOUR so the pre-dawn night belongs
       *  to the previous filtration day and is filled LAST (daytime bias). */
      function filtrationDay(now: Date): string {
        const d = new Date(now);
        if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
        return localDay(d);
      }
      /** Deadline catch-up so the target is ALWAYS met. Outside daylight, run
       *  once the time left until the 06:00 boundary is only just enough to fit
       *  the hours still owed. Starting as late as possible means the off-peak
       *  night hours are used first (via rule 2) and peak-tariff running is the
       *  minimal remaining tail. */
      function nightCatchUp(now: Date): boolean {
        if (isDaytime(now)) return false; // daytime is handled by rules 1-3
        const targetH = num(ctx.state.get("targetHours"));
        const remainingH = targetH - num(ctx.state.get("runSecondsToday")) / 3600;
        if (remainingH <= 0) return false;
        const m = minutesOfDay(now);
        const dayStartM = DAY_START_HOUR * 60;
        const hoursUntilBoundary = (m < dayStartM ? dayStartM - m : dayStartM + 1440 - m) / 60;
        return remainingH >= hoursUntilBoundary; // no slack left → must run now
      }

      /** Today's run time has not reached the target (always true without one). */
      function belowTarget(): boolean {
        if (!hasTarget) return true;
        const targetH = ctx.state.get("targetHours");
        if (typeof targetH !== "number" || targetH <= 0) return true; // no valid gate yet
        return num(ctx.state.get("runSecondsToday")) < targetH * 3600;
      }
      /** Not enough run time has landed in broad daylight yet (effectiveness). */
      function daytimeBelowFloor(): boolean {
        return num(ctx.state.get("daytimeSecondsToday")) < daytimeMinHours * 3600;
      }

      /**
       * Priority ladder. Optional forced windows always win. Then, in target
       * mode and only while the daily target is unmet: solar surplus (free,
       * partial ok) → off-peak (afternoon then night) → a guaranteed daytime
       * floor (may cost peak energy) → the pre-dawn night safety net.
       */
      function desiredState(now: Date): "ON" | "OFF" {
        if (activeWindow(now, windows) !== null) return "ON"; // optional forced windows
        if (!hasTarget) return "OFF"; // schedule-only (v1.1.0)
        if (!belowTarget()) return "OFF"; // daily target reached → stop
        if (runOnSurplus && arbiterGranted) return "ON"; // 1. solar surplus (free/partial)
        if (inHcSlot(now)) return "ON"; // 2. off-peak HC (afternoon, then night)
        if (isDaytime(now) && daytimeBelowFloor()) return "ON"; // 3. daytime effectiveness floor
        if (nightCatchUp(now)) return "ON"; // 4. deadline catch-up → target always met
        return "OFF";
      }

      // Mirrors desiredState's branch order so the decision log names the rule
      // the ladder actually took.
      function currentReason(now: Date): string {
        const w = activeWindow(now, windows);
        if (w) return windowLabel(w);
        if (runOnSurplus && arbiterGranted) return "surplus";
        if (inHcSlot(now)) return "heures creuses";
        if (isDaytime(now) && daytimeBelowFloor()) return "journée";
        return "rattrapage nuit";
      }
      function syncStateLabels(now: Date, expected: "ON" | "OFF"): void {
        setIfChanged("status", expected === "ON" ? "running" : "idle");
        setIfChanged("currentSlot", expected === "ON" ? currentReason(now) : null);
      }

      /** Compact progress string for the decision logs (audit trail). */
      function progress(): string {
        if (!hasTarget) return "";
        const run = num(ctx.state.get("runSecondsToday")) / 3600;
        const tgt = num(ctx.state.get("targetHours"));
        const day = num(ctx.state.get("daytimeSecondsToday")) / 3600;
        return ` [${run.toFixed(1)}/${tgt.toFixed(1)} h, jour ${day.toFixed(1)}/${daytimeMinHours} h]`;
      }
      /** One-line decision log, so a later audit shows WHY the pump moved. */
      function logLine(expected: "ON" | "OFF", now: Date, trigger: string): string {
        if (expected === "ON") {
          return `Pompe ${pumpName()} → ON via ${currentReason(now)} (${trigger})${progress()}`;
        }
        const why = hasTarget && !belowTarget() ? "cible atteinte" : "aucune heure favorable";
        return `Pompe ${pumpName()} → OFF, ${why} (${trigger})${progress()}`;
      }

      /** Publish the filtration-target figures for the instance UI. */
      function updateTargetDisplay(): void {
        if (!hasTarget) return;
        const targetH = num(ctx.state.get("targetHours"));
        const runH = num(ctx.state.get("runSecondsToday")) / 3600;
        setIfChanged("runHoursToday", Math.round(runH * 10) / 10);
        setIfChanged("remainingHours", Math.max(0, Math.round((targetH - runH) * 10) / 10));
      }

      /** Force the desired state to the device (used at schedule edges — the
       *  order is re-asserted even when the device already matches). */
      async function fireEdge(reason: string): Promise<void> {
        const now = new Date();
        const expected = desiredState(now);
        syncStateLabels(now, expected);
        ctx.log(logLine(expected, now, reason));
        await dispatch(expected);
      }

      /** Reconcile the observed state toward the desired one, sending only on
       *  mismatch. `corrective` = drift/guard (warn + cooldown); otherwise a
       *  normal transition (info, no cooldown). Stands down under a dérogation. */
      function reconcile(reason: string, corrective: boolean): void {
        if (ctx.state.get("override") === true) return;
        const now = new Date();
        const expected = desiredState(now);
        syncStateLabels(now, expected);
        const actual = readPumpState();
        if (actual === null || actual === expected) return;
        if (corrective && hasTarget && expected !== lastAutoDesired) {
          // The 5-min guard caught an auto transition before the 30 s tick did:
          // log it as the normal rule-named transition, not a drift correction.
          lastAutoDesired = expected;
          ctx.log(logLine(expected, now, reason));
        } else if (corrective) {
          if (Date.now() - lastCorrection < CORRECTION_COOLDOWN_MS) return;
          lastCorrection = Date.now();
          ctx.log(
            `Réconciliation (${reason}) — pompe ${pumpName()} ${actual} au lieu de ${expected}, ordre correctif${progress()}`,
            "warn",
          );
        } else {
          ctx.log(logLine(expected, now, reason));
        }
        void dispatch(expected);
      }

      /** Roll the daily counters over, finalise yesterday's average water
       *  temperature and compute today's filtration target. */
      function rolloverIfNeeded(now: Date): void {
        const today = filtrationDay(now);
        if (ctx.state.get("day") === today) return;
        const firstInit = ctx.state.get("day") == null;
        if (!firstInit && hasTarget) {
          // Auto-mode backstop: a genuine day boundary lifts any lingering manual
          // dérogation so it never outlives the filtration day. Auto-only on
          // purpose — the H-1 latch existed only in bare auto mode (no window
          // edges to clear it); schedule mode keeps its documented contract of
          // holding the dérogation until the next configured window edge.
          if (ctx.state.get("override") === true) ctx.state.set("override", false);
          const count = num(ctx.state.get("tempCountToday"));
          if (count > 0) {
            ctx.state.set(
              "waterTempYesterday",
              Math.round((num(ctx.state.get("tempSumToday")) / count) * 10) / 10,
            );
          }
        }
        if (hasTarget) {
          const yTemp = ctx.state.get("waterTempYesterday");
          const known = typeof yTemp === "number";
          const seed = known ? (yTemp as number) : readWaterTemp() ?? BOOTSTRAP_TEMP;
          const target = computeTargetHours(seed, { maxHours, refTemp, minHours });
          ctx.state.set("targetHours", target);
          ctx.state.set("waterTempUsed", Math.round(seed * 10) / 10);
          ctx.log(
            `Cible de filtration du jour : ${target} h (eau ${Math.round(seed * 10) / 10} °C, ${known ? "moyenne de la veille" : "estimation initiale"})`,
          );
        }
        ctx.state.set("day", today);
        ctx.state.set("runSecondsToday", 0);
        ctx.state.set("daytimeSecondsToday", 0);
        ctx.state.set("tempSumToday", 0);
        ctx.state.set("tempCountToday", 0);
        lastAutoDesired = null; // re-evaluate the ladder after the daily reset
      }

      /** Accumulate run time and sample the water temperature while running. */
      function account(now: Date): void {
        const nowMs = now.getTime();
        const running = readPumpState() === "ON";
        if (lastAccountAt !== null && running) {
          const dt = (nowMs - lastAccountAt) / 1000;
          if (dt > 0 && dt < 3600) {
            ctx.state.set("runSecondsToday", num(ctx.state.get("runSecondsToday")) + dt);
            if (isDaytime(now)) {
              ctx.state.set("daytimeSecondsToday", num(ctx.state.get("daytimeSecondsToday")) + dt);
            }
          }
          if (hasTarget) {
            const t = readWaterTemp();
            if (t !== null) {
              ctx.state.set("tempSumToday", num(ctx.state.get("tempSumToday")) + t);
              ctx.state.set("tempCountToday", num(ctx.state.get("tempCountToday")) + 1);
            }
          }
        }
        lastAccountAt = nowMs;
      }

      /** Hold a surplus claim while the pump still needs to run today. */
      function manageClaim(): void {
        if (!runOnSurplus || !hasTarget) return;
        let enabled = false;
        try {
          enabled = !!ctx.helpers.energy && ctx.helpers.energy.getCapacityState().enabled;
        } catch {
          enabled = false;
        }
        const want = enabled && belowTarget() && ctx.state.get("override") !== true;
        if (want && !claim && ctx.helpers.energy) {
          try {
            claim =
              ctx.helpers.energy.claimCapacity({
                equipmentId: pumpId,
                toleratedImportW, // accept a partial surplus (import a little to catch it)
                slack: "high", // the pump is very sheddable — yields to priority loads
                note: "pool filtration on surplus",
                onGranted: () => {
                  arbiterGranted = true;
                  ctx.log(`Surplus solaire accordé par l'arbitre${progress()}`);
                  scheduleTick();
                },
                onRevoked: (why: string) => {
                  arbiterGranted = false;
                  ctx.log(`Surplus retiré par l'arbitre (${why})${progress()}`);
                  scheduleTick();
                },
              }) ?? null;
          } catch (err) {
            ctx.logger.error({ err }, "pool-pump: claimCapacity failed");
            claim = null;
          }
        } else if (!want && claim) {
          try {
            claim.release();
          } catch {
            /* a broken handle must not break the recipe */
          }
          claim = null;
          arbiterGranted = false;
        }
      }

      // Deferred re-check — the arbiter may call onGranted/onRevoked
      // synchronously from inside claimCapacity(); never re-enter the pass.
      function scheduleTick(): void {
        if (tickScheduled || stopped) return;
        tickScheduled = true;
        setTimeout(() => {
          tickScheduled = false;
          try {
            if (!stopped) reconcile("surplus", false);
          } catch (err) {
            ctx.logger.error({ err }, "pool-pump: surplus tick failed");
          }
        }, 0);
      }

      /** 30 s accounting pass: runtime + temperature sampling, daily roll-over,
       *  claim upkeep, target display. It never sends an order except to stop
       *  the pump the moment the daily target is reached — so with no target
       *  configured it is inert (v1.1.0 control is untouched). */
      function accountingTick(): void {
        if (stopped) return;
        try {
          const now = new Date();
          rolloverIfNeeded(now);
          account(now);
          manageClaim();
          updateTargetDisplay();
          // Auto mode: drive transitions from the 30 s tick so HC / daytime /
          // night starts and the target-met stop are timely AND logged with the
          // rule that actually fired (not the 5-min corrective guard). Inert in
          // schedule-only mode (desiredState only changes at window edges, which
          // the edge timers already own).
          if (hasTarget) {
            const expected = desiredState(now);
            if (expected !== lastAutoDesired) {
              lastAutoDesired = expected;
              // An auto transition is the natural "edge": it lifts a manual
              // dérogation so the recipe resumes control. Schedule mode clears
              // `override` at window edges; auto mode has none, so this is the
              // analog (without it, a manual order latches override forever).
              if (ctx.state.get("override") === true) {
                ctx.state.set("override", false);
                ctx.log(`Dérogation levée (transition auto) sur ${pumpName()}`);
              }
              reconcile("cycle", false);
            }
          }
        } catch (err) {
          ctx.logger.error({ err }, "pool-pump: accounting tick failed");
        }
      }

      function scheduleStart(w: Window): void {
        const delay = msUntilTime(w.start);
        const timer = setTimeout(() => {
          try {
            setIfChanged("override", false); // dérogation lifts at the slot edge
            rolloverIfNeeded(new Date());
            manageClaim();
            fireEdge(`début créneau ${windowLabel(w)}`).catch((err) =>
              ctx.logger.error({ err, slot: w.start }, "Start fire failed"),
            );
          } catch (err) {
            ctx.logger.error({ err, slot: w.start }, "pool-pump: start edge failed");
          } finally {
            scheduleStart(w); // re-arm even if the prologue threw
            updateNextLabels();
          }
        }, delay);
        startTimers.set(w.index, timer);
      }

      function scheduleEnd(w: Window): void {
        const delay = msUntilTime(w.end);
        const timer = setTimeout(() => {
          try {
            setIfChanged("override", false);
            manageClaim();
            fireEdge(`fin créneau ${windowLabel(w)}`).catch((err) =>
              ctx.logger.error({ err, slot: w.end }, "End fire failed"),
            );
          } catch (err) {
            ctx.logger.error({ err, slot: w.end }, "pool-pump: end edge failed");
          } finally {
            scheduleEnd(w); // re-arm even if the prologue threw
            updateNextLabels();
          }
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
          try {
            reconcile("état pompe", true);
          } catch (err) {
            ctx.logger.error({ err }, "pool-pump: state-change handler failed");
          }
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
              hasTarget
                ? `Ordre manuel détecté sur ${pumpName()}. Dérogation jusqu'à la prochaine transition automatique.`
                : `Ordre manuel détecté sur ${pumpName()}. Dérogation jusqu'au prochain créneau.`,
            );
          }
        }),
      );

      // First pass: compute today's target, then reconcile the observed state.
      rolloverIfNeeded(new Date());
      account(new Date());
      manageClaim();
      updateTargetDisplay();
      reconcile("démarrage", true);
      lastAutoDesired = desiredState(new Date());

      guardTimer = setInterval(() => {
        try {
          reconcile("garde périodique", true);
        } catch (err) {
          ctx.logger.error({ err }, "pool-pump: guard tick failed");
        }
      }, RECONCILE_INTERVAL_MS);
      accountTimer = setInterval(accountingTick, TICK_INTERVAL_MS);

      const labels = windows.map(windowLabel).join(", ");
      ctx.log(
        hasTarget
          ? `Recette démarrée (mode auto) — pompe ${pumpName()} : cible eau/${refTemp}°C→${maxHours}h, plancher ${minHours}h, plancher jour ${daytimeMinHours}h` +
              (runOnSurplus ? `, surplus (tolérance ${toleratedImportW} W)` : "") +
              (windows.length ? `, ${windows.length} créneau(x) forcé(s) [${labels}]` : "")
          : `Recette démarrée (planning) — pompe ${pumpName()}, ${windows.length} créneau(x) [${labels}]`,
      );

      return {
        stop(): void {
          stopped = true;
          for (const t of startTimers.values()) clearTimeout(t);
          for (const t of endTimers.values()) clearTimeout(t);
          startTimers.clear();
          endTimers.clear();
          if (guardTimer) clearInterval(guardTimer);
          if (accountTimer) clearInterval(accountTimer);
          guardTimer = null;
          accountTimer = null;
          for (const unsub of unsubs) unsub();
          unsubs.length = 0;
          if (claim) {
            claim.release();
            claim = null;
          }

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
