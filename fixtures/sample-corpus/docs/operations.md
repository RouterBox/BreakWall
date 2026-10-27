# Operations

## Restart order

Start the timetable store first, then `TideQueue`, then `harbor-api`. Starting `harbor-api` first is safe but it serves stale departures until the store answers.

## Configuration

`TIDE_DB_URL` points at the timetable store. `harbor-api` listens on port 8080 unless `TIDE_PORT` is set.

## Incidents

Follow the [incident runbook](runbook.md) for paging and escalation.
