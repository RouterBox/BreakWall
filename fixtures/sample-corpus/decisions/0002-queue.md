# ADR 0002: Move ingest to TideQueue

## Context

Inline parsing in `harbor-api` timed out on large uploads ([ingest v1](../docs/ingest-v1.md)).

## Decision

Parse uploads in the `TideQueue` worker pool and answer the upload request with a job id.

## Consequences

Operators poll for the result. The API stays fast because it only stores the file and enqueues.
