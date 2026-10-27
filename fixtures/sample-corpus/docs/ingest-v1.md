---
status: superseded
superseded_by: ingest-v2.md
---
# Timetable ingest v1

## Overview

`harbor-api` parsed uploaded timetables inline, inside the upload request, and wrote rows straight to the timetable store.

## Problems

Large timetables timed out the upload request, and a half-parsed file left partial rows behind.
