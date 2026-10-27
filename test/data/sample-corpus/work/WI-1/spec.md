---
status: approved
---
# Login spec

## Goals

Users sign in with an email and a one-time code. Sessions use the token format described in the [storage design](design.md#storage).

## Requirements

Session tokens expire after 30 minutes of inactivity. A failed code attempt is rate limited to five tries per hour.

## Out of scope

Single sign-on and password login are not part of this work item.
