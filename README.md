# pi-ooc

`pi-ooc` adds a `/ooc` command to pi.

It lets you ask a side question with the **full current session context** while keeping the exchange **out of the main session history**.

The result is shown in a TUI overlay, so you can read it immediately without polluting the main agent's context window.

## Install

### Option 1: Install from npm

```bash
pi install npm:@mjakl/pi-ooc
```

### Option 2: Install via git

```bash
pi install git:github.com/mjakl/pi-ooc
```

### Option 3: Install local package

```bash
pi install ./
```

## Usage

```text
/ooc What assumptions have we made so far?
/ooc Give me three alternative designs for this refactor.
/ooc Based on the current thread, what would you challenge?
```

## What it does

When you run `/ooc ...`, the extension:

1. waits for the main agent to become idle if needed
2. snapshots the **current session context** via `buildSessionContext()`
3. uses the **current model** and **current system prompt**
4. sends your `/ooc` question together with that context directly to the model
5. streams the answer into a TUI overlay
6. closes without adding either the question or the answer to the main session

## Important behavior

- The `/ooc` exchange is **not appended** to your current session.
- The result is **shown in the TUI only**.
- The command itself is an extension command, so it bypasses the normal agent turn.
- Session context includes the current branch as built by pi, including things like compaction summaries and branch summaries.

## Trade-offs

`pi-ooc` intentionally performs a **direct model call** instead of starting a second full agent loop.

That means:

- it gets the current session context
- it uses the selected model and thinking level
- it does **not** run tools
- it does **not** mutate files
- it does **not** create hidden follow-up turns in your main session

This makes it a good fit for:

- side questions
- challenge prompts
- summarization
- alternative framing
- architecture second opinions

If you want a fully isolated tool-using side agent instead, `pi-subagent` is the better fit.

## Keys inside the overlay

- `Esc` or `q` - close
- `↑` / `↓` - scroll
- `PgUp` / `PgDn` - page scroll
- `g` / `G` - jump to top / bottom

## Why this exists

Sometimes you want:

- the benefit of the current thread's context
- without spending even more context budget on the reply itself
- and without turning the side question into part of the main conversation

That's exactly what `/ooc` is for.

## License

MIT
