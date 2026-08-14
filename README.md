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

### Night deadline latch (v1.4.1)

Once the night deadline catch-up engages, it **holds ON** until the target is
met. It used to compare the remaining target against the time left before the
06:00 boundary with a bare threshold, which chattered ON/OFF at the crossing
when the two values sat within a tick of each other. Latching removes the
chatter; the target gate still stops the pump as soon as the day's target is
reached.

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
