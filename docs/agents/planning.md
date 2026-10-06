<!-- atlas-v3:planning:start -->
# Repository planning profile

This document is the repository's scoped planning profile. Each entry has the
authority named by its classification; the document is not blanket mandatory
policy.

Read this guide before clarifying, researching, prototyping, specifying,
decomposing, technically planning, or red-team reviewing proposed work. It
routes repository-specific concerns; generic planning mechanics remain in the
invoked skill.

| Classification | Trigger | Required consideration |
|---|---|---|
| Atlas recommendation | Ticket lacks a clear problem, outcome, or bounded decision | Return to /grill-with-docs, Wayfinder, /to-spec, or /to-tickets as appropriate. |
| confirmed team policy | Any feature work on the app | Write a plan, run atlas-red-team on it, post it to the issue, and wait for human approval before implementing. |
| discovered repository fact | Any change to the app | The app must remain a single Site/index.html with inline CSS and plain JavaScript; no frameworks, dependencies, or build step (shuffle.md). Everything the browser loads lives under Site/. |
| discovered repository fact | Any change to the app or its verification | test-results/verify.cjs is the Playwright verification driver and is extended per work package with checks written from the plan, never from the app code. Clearing the evidence root keeps verify.cjs. |

Classifications have distinct authority: confirmed team policy is mandatory;
Atlas recommendations are proposals; discovered repository facts are evidence;
unresolved questions must not be silently converted into policy.

## Work-package plan contract

`/atlas-plan <ticket-epic-or-spec>` reads the complete stable contract, existing
technical or execution plan, dependencies, decisions, and relevant repository
areas. For tracked work it also reads state, comments, linked parent specs, and
applicable children. Its plan covers intent, affected areas and interfaces,
ordered steps, declared scope, dependencies, AC and DoD coverage, run surface,
verification commands, real-dependency checks, fixtures, and human
prerequisites. It preserves the stable contract and adequate existing plan
content.

Return an unclear or unbounded work package to `/grill-with-docs`, Wayfinder,
`/to-spec`, or `/to-tickets`; a stable repository spec is a valid input, but
`/atlas-plan` does not invoke those flows or create product specs or child
tickets from unresolved material.

## Review and publication

Red-team policy: Required for every feature plan before implementation.

Storage: **tracker**. Drafts before approval:
**true**. A repository spec uses
the planning section of sibling `execution.md`; tracked work uses the configured
storage. Exact file or tracker mutations are previewed before publication. Read
`docs/agents/issue-tracker.md` for the authoritative approval, persistence, and
ticket status rules, `docs/agents/triage-labels.md` for decomposition,
`docs/agents/domain.md` for terminology, and `docs/agents/testing.md` for AC,
DoD, fixture, and verification design.
<!-- atlas-v3:planning:end -->
