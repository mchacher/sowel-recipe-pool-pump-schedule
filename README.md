# sowel-recipe-pool-pump-schedule

Sowel recipe plugin for a pool pump. Two modes that combine freely:

- **Schedule** — up to 3 daily on/off windows (the original v1.1 behaviour).
- **Auto (target)** — set a water-temperature sensor and the recipe computes a
  daily filtration-time target and reaches it on the cheapest energy available:
  solar surplus, then off-peak, then a daytime floor, then a night safety net.

## Install

From the Sowel UI, go to Plugins, Store, "Programmation pompe piscine".

## Parameters

| Param                | Type       | Required | Default | Description                                                                 |
| -------------------- | ---------- | -------- | ------- | --------------------------------------------------------------------------- |
| `pump`               | equipment  | yes      |         | `pool_pump` equipment to drive (`state` order)                              |
| `waterTempSensor`    | equipment  | no       |         | Water-temperature sensor. Setting it turns on the **auto (target)** model   |
| `maxFiltrationHours` | number     | no       | 12      | Filtration hours at the reference temperature                               |
| `filtrationRefTemp`  | number     | no       | 30      | Reference water temperature (°C) for the max hours                          |
| `minFiltrationHours` | number     | no       | 3       | Floor on the daily target regardless of temperature                         |
| `daytimeMinHours`    | number     | no       | 3       | Minimum hours to run in daylight even without surplus                       |
| `runOnSurplus`       | boolean    | no       | false   | Run on solar surplus via the capacity arbiter (Sowel 1.39+)                 |
| `toleratedImportW`   | number     | no       | 300     | Grid import accepted to catch a partial surplus (0 = full surplus only)     |
| `slot1_start`        | time       | no       |         | Forced window 1 start (HH:MM)                                               |
| `slot1_end`          | time       | no       |         | Forced window 1 end (HH:MM)                                                 |
| `slot2_start` / `slot2_end` | time | no      |         | Forced window 2                                                            |
| `slot3_start` / `slot3_end` | time | no      |         | Forced window 3                                                            |

Forced windows work in both modes: the pump is always ON inside a window
(`state = "ON"` at the start, `state = "OFF"` at the end; `end < start`
crosses midnight). In auto mode leaving the windows empty is normal.

## Auto (target) model

Each filtration day (which rolls over at **06:00**) the recipe derives a target:

```
targetHours = clamp(waterTemp * maxFiltrationHours / filtrationRefTemp,
                    min = minFiltrationHours, max = maxFiltrationHours)
```

The water temperature is yesterday's average (sampled while the pump runs),
falling back to the current reading, then a bootstrap estimate.

While the day's target is unmet, a priority ladder picks when to run — cheapest
energy first:

1. **Forced window** — always wins if configured.
2. **Solar surplus** — claims the [surplus arbiter](https://docs.sowel.org); a
   partial surplus is accepted up to `toleratedImportW`.
3. **Off-peak (HC)** — any off-peak slot from the contract, whenever it falls.
4. **Daytime floor** — guarantees `daytimeMinHours`, deferred toward sunset so
   free surplus and off-peak get first chance (may cost peak-price energy).
5. **Night deadline catch-up** — the last-resort safety net: run before the
   06:00 boundary so the target is always met.

The pump stops the moment the daily target is reached. Every decision is logged
with the rule that fired, for audit.

Without an arbiter, tariff, or sunlight helper the corresponding rungs are
skipped and the recipe still runs on schedule/target — nothing throws.

### Deferred-rung latches (v1.4.1, v1.4.2)

The two deferred rungs — the **daytime floor** (rung 3) and the **night deadline
catch-up** (rung 5) — each fire when a remaining need can no longer be met before
a deadline (sunset, resp. the 06:00 boundary). Both used a bare `>=` threshold,
which chattered ON/OFF every ~30 s at the crossing, when the two sides sat within
a tick of each other. Each rung now **latches ON** once engaged and holds until
its need is met (the daytime minimum, resp. the daily target) or its window ends
(sunset / a new day). v1.4.1 fixed the night rung; v1.4.2 the daytime floor.

### Solar-surplus heating (v1.5.0+)

Setting a `heater` (a heat pump exposing a `setpoint` order) turns on optional
pool heating driven by the surplus arbiter. The lever is the setpoint, never a
power cut: on a grant the setpoint is raised to `heatingTargetTemp` (0.5 °C
hysteresis); otherwise it is held at `heaterIdleSetpoint`. Heating strictly
depends on the pump's own surplus grant (#564) — the heat pump must never run
without water flow.

**The arbiter owns the exit (v1.8.0, #22).** The recipe asks for capacity and
holds its claim until the arbiter takes it back. It runs no surplus test of its
own: while a claim is granted, whether the surplus still covers it is the
arbiter's question.

This reverses v1.6.3 (#18), which watched the signed grid balance and released
the heater itself after ~3 min of import. The intent was sound — the arbiter
shields a grant for its full `minOnS`, an anti-short-cycle meant for hard
relays, and that shield kept the heat pump heating through a real deficit — but
the remedy put the decision in the wrong place. It made the recipe a second,
faster surplus authority, and on the reference installation the consequence was
measurable: over a week the heat pump took **27 grants and never once got
revoked**. Every grant ended in a recipe-side release, so the arbitration
timeline showed a mute "libéré" where the household expected "surplus retiré",
the short-cycle metric counted zero, and `minOffS` never armed — the load
re-claimed within the minute, cycling the setpoint four times in an afternoon.

The shield is **configuration, not code**. Set the heat pump's
`energyProfile.minOnS` to `0`: the lever is a soft setpoint and the machine
self-protects, so it needs no anti-short-cycle floor, and the arbiter is then
free to revoke on its own `releaseHoldS` (10 min by default). Keep `minOffS` at
a real value — with a genuine revoke it finally does its job and stops the load
from re-claiming immediately. Set `toleratedImportW` to `0` so the arbiter's
accounting agrees that any import means "no surplus".

Leaving `minOnS` at a non-zero value is still safe; it simply means the heat pump
keeps heating until the shield lapses, which is the behaviour the arbiter is
documented to have.

**Declares its loads' state to the arbiter (v1.7.0, spec 166).** Neither the pump nor the pool heat pump is individually metered on a typical installation, so the arbiter has no measurement to read and could only ever show them "accordé" under a grant. While a claim is granted the recipe now declares whether that load actually needs current: the heater reports whether heating is engaged (which is false in the "attente pompe" window, where its watts are reserved but the setpoint is still parked at idle), and the pump reports its own ON/OFF decision with the observed state allowed to veto it, so a pump commanded ON but not running reads as at rest rather than green. The call is optional, so on a core older than spec 166 nothing changes.

## Behaviour on stop

Disabling or deleting a running instance overrides control and sends an
immediate `OFF` (dérogation).

## Build & test

```bash
npm install
npm run build
npm test
```

## License

AGPL-3.0
