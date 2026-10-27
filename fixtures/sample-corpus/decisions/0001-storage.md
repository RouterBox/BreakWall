# ADR 0001: PostgreSQL for the timetable store

## Context

Timetables are small, relational and versioned. Riders need consistent reads while a new version is written.

## Decision

Use PostgreSQL, reached through `TIDE_DB_URL`. Each timetable version is a row set written in one transaction.

## Consequences

Versioning is a column, not a separate database. See the [architecture](../docs/architecture.md#components).
