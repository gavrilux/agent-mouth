## Problem

`.gitignore` line 5 is `~/.agent-mouth/`. Git does not expand `~` — it treats it as a literal path segment named `~`. The pattern will never match anything inside the repo.

The line is harmless but misleading to anyone reading the file.

## Suggested approach

Two options:

**Option A — remove it entirely** (cleanest):

```diff
- ~/.agent-mouth/
```

The runtime config directory lives outside the repo, no `.gitignore` entry is needed.

**Option B — replace with a comment** (more documenting):

```gitignore
# Runtime config lives at ~/.agent-mouth/config.json (outside the repo — no gitignore needed)
```

## Files

- `.gitignore`

## Acceptance criteria

- The non-functional `~/.agent-mouth/` line is gone (or replaced by a clarifying comment)
- No other gitignore behavior changes
