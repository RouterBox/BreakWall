---
status: draft
---
# Login design

## Storage

Session tokens are stored hashed in the sessions table with an expiry timestamp. The raw token never touches disk.

## API

POST /login/code sends the one-time code. POST /login/verify exchanges the code for a session token.

## Risks

Clock skew between the API and the database can shorten sessions. See the [notes](../../docs/notes.md).

## Migration

Existing sessions are invalidated on deploy and users sign in again.
