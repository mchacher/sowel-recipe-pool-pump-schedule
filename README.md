# sowel-recipe-pool-pump-schedule

Sowel recipe plugin — scheduled on/off for a pool pump with up to
3 daily time windows.

## Install

From the Sowel UI → Plugins → Store → "Programmation pompe piscine".

## Parameters

| Param          | Type       | Required | Description                    |
| -------------- | ---------- | -------- | ------------------------------ |
| `pump`         | equipment  | yes      | `pool_pump` equipment to drive |
| `slot1_start`  | time       | yes      | Window 1 start (HH:MM)         |
| `slot1_end`    | time       | yes      | Window 1 end (HH:MM)           |
| `slot2_start`  | time       | no       | Window 2 start                 |
| `slot2_end`    | time       | no       | Window 2 end                   |
| `slot3_start`  | time       | no       | Window 3 start                 |
| `slot3_end`    | time       | no       | Window 3 end                   |

For each window, the recipe fires `state = "ON"` at the start time
and `state = "OFF"` at the end time. When `end < start`, the window
crosses midnight naturally.

## Behaviour on stop

Disabling or deleting a running instance overrides the schedule and
sends an immediate `OFF` command (dérogation).

## Build & test

```bash
npm install
npm run build
npm test
```

## License

AGPL-3.0
