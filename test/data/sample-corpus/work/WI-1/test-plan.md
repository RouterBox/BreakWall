# Login test plan

## Happy path

A valid code returns a session token that works for thirty minutes.

## Rate limit

The sixth failed attempt within an hour returns HTTP 429.
