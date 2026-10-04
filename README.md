# Shuffle

A simple sliding tile puzzle web app: a 3x3 grid of tiles numbered 1-8 with one empty space, a Shuffle button, a move counter, and a timer.

The whole app is a single `index.html` with inline CSS and plain JavaScript. No frameworks, no build step.

## Run

From the repo root, run `python -m http.server 8000`, then open http://localhost:8000/.

Pictures dropped into `images/` (jpg, jpeg, png, webp, gif, avif) appear in the New dialog the next time it is opened. Opening `index.html` directly in a browser still plays numbers and your own image files, but without the preset pictures.

See [`shuffle.md`](shuffle.md) for the product spec.

## Settings

`settings.json` in the repo root sets the puzzle sizes offered in the New dialog. Rows are the vertical count, columns the horizontal count; each has a smallest (`min`) and largest (`max`) value.

```json
{
  "grid": {
    "rows": { "min": 3, "max": 10 },
    "columns": { "min": 3, "max": 10 }
  }
}
```

Values must be whole numbers from 3 to 12. A missing or invalid value uses its default (3 for `min`, 10 for `max`); if a `min` ends up above its `max`, that pair goes back to 3 to 10. Changes show the next time the page loads.

The app reads this file only when served over HTTP (`python -m http.server`, see **Run**). Opened directly as a `file://` page, it offers 3 to 10.


<!-- atlas-v3:readme:start -->
## Atlas

This repo uses Atlas, a Claude Code plugin that acts as a shared path for AI-assisted development — generated, customizable policies, guidelines, and guardrails that keep agent-driven work safe and consistent without locking teams into one rigid workflow. Read [`docs/atlas-operators-guide.md`](./docs/atlas-operators-guide.md) for how to work in this repo, in plain language, and the **Atlas** section in [`CLAUDE.md`](./CLAUDE.md) for the policy the agents follow.

**Before working in this repo:**

1. **Activate git hooks** (one-time, per clone):

   ```bash

   git config core.hooksPath .githooks

   ```

   These block a handful of destructive git operations before they run.

2. **Claude Code hooks** are already configured in `.claude/settings.json` — they guard against risky file, shell, and MCP actions during agent sessions. See `docs/agents/guardrails.md` if you need to change them.

Everything Atlas generated here — hooks, the `CLAUDE.md` section, `docs/agents/` — is a **base recommendation**, not fixed policy. Adapt it to this project's actual needs and processes.
<!-- atlas-v3:readme:end -->
