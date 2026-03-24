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
2. starts an **isolated child pi agent session**
3. seeds that child session with the **current session context**
4. uses the **current model** and **thinking level**
5. lets the child agent run its normal loop, including tools
6. streams the child agent's answer into a TUI overlay
7. closes without adding either the question or the answer to the main session

## Important behavior

- The `/ooc` exchange is **not appended** to your current session.
- The result is **shown in the TUI only**.
- The command itself is an extension command, so it bypasses the normal agent turn.
- The side agent is isolated from your **conversation history**, not from your **filesystem**.
- If the side agent decides to use tools, those tool actions are real.

## Trade-offs

`pi-ooc` now starts a **separate isolated agent session** instead of doing a direct model call.

That means:

- it gets the current session context
- it uses the selected model and thinking level
- it **can** run tools
- it **can** mutate files
- it does **not** add hidden follow-up turns to your main session
- it behaves much more like a normal pi run, just in a side overlay

This makes it a good fit for:

- side questions that may need tools
- challenge prompts
- repository inspection
- alternative framing
- architecture second opinions
- isolated exploratory work you do not want in the main session history

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
