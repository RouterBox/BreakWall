# Tidewater Architecture

## Overview

Tidewater publishes ferry departures for a chain of island ports. Operators upload timetables, riders query them, and a nightly job reconciles both against the harbour master's feed. The system has three moving parts: `harbor-api`, the `TideQueue` worker pool and the timetable store.

## Components

Tidewater has 3 components:

| Component | Role |
|---|---|
| `harbor-api` | HTTP API on port 8080 for riders and operators |
| `TideQueue` | background workers that ingest uploaded timetables |
| Timetable store | PostgreSQL database reached through `TIDE_DB_URL` |

## Request flow

A rider asks `harbor-api` for the next departures from a port. The API reads the timetable store directly; it never waits on `TideQueue`. Responses are cached for sixty seconds per port, because departures rarely change within a minute and the islands have slow links.

Operators upload a timetable file to `harbor-api`, which stores the raw file, enqueues an ingest job on `TideQueue` and answers at once with a job id. The operator polls the job id until the ingest finishes or fails.

Every response carries the timetable version it was computed from, so a rider who sees an odd departure can report the exact version. Support staff use that version to replay the ingest that produced it.

The cache is keyed by port and version. When an ingest completes, the version changes, so stale entries simply stop being read and expire on their own; nothing has to flush the cache by hand.

When the harbour master's feed disagrees with an uploaded timetable, the feed wins for the next twenty-four hours and the disagreement is written to the reconciliation log. A human reviews the log each morning and either fixes the upload or files a correction with the harbour master.

Weather cancellations do not go through ingest at all. They arrive as short notices from the harbour master and are overlaid on the timetable at read time, which keeps a storm from triggering a full re-ingest of every port.

Holiday timetables are uploaded weeks ahead as separate versions with a start date. The API switches to them at midnight local time for each port, so the islands in a different time zone switch an hour apart, which is what the operators expect.

## Failure modes

If the timetable store is unreachable, `harbor-api` serves the cached departures and marks them stale. If `TideQueue` is down, uploads are accepted and wait; nothing is lost because the raw file is stored first. See [operations](operations.md) for the restart order.
