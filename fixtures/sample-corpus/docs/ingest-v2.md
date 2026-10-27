---
status: current
supersedes: ingest-v1.md
---
# Timetable ingest v2

## Overview

Uploads are parsed by `TideQueue` workers, not by `harbor-api`. The decision is recorded in [ADR 0002](../decisions/0002-queue.md).

## Steps

1. Store the raw upload and enqueue a job.
2. Parse the file and validate every departure against the port list.
3. Write the new timetable version in one transaction, so a failed ingest leaves no partial rows.

## Retries

A job that fails validation is not retried; the operator gets the list of bad rows. A job that fails on the database is retried three times with backoff.
