# services/

**Intentionally empty.**

Per decision [AD-01](../docs/plans/000-decisions.md), Nexus Forge is a
**modular monolith**: all components live as packages in `packages/` and
entrypoints in `apps/`, deployed as one process (`--role all`) or two
(`app` + `worker`) from the same codebase.

This directory is reserved for the case where a component must be extracted
into an independently deployed service. The extraction criteria (discovery
§3.2) are:

1. It needs independent scaling (e.g., a render farm), **or**
2. It needs a different runtime/security domain (e.g., a publishing agent
   holding YouTube OAuth tokens), **or**
3. It needs an independent deployment cadence.

Do not create anything here until one of those criteria is demonstrably met.
