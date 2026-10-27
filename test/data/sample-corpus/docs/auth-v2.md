---
status: current
supersedes: auth-v1.md
---
# Authentication v2

## Overview

Sign in uses one-time codes. Sessions expire after 30 minutes of inactivity.

## Token storage

Tokens are hashed before storage, as designed in [the login design](../work/WI-1/design.md#storage).
