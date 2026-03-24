# pi-ooc

Sometimes you want to ask pi a side question without dragging that detour back into your main conversation.

`pi-ooc` adds `/ooc`, which opens an isolated side-agent with the full current session context, shows the result in an overlay, and keeps that whole exchange out of your main session history.

Think of it as: *"use everything we know so far, but don't make this part of the main thread."*

## Install

### Option 1: Install from npm (recommended)

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
/ooc Inspect the repo and tell me where the auth flow starts.
/ooc Challenge the current plan and tell me what we're missing.
```

And of course my guilty pleasure: `/ooc commit`

## What happens

When you run `/ooc ...`:

1. pi waits for the current agent to become idle if needed
2. a separate side-agent session is started
3. that side-agent gets the full current session context
4. it uses the current model and thinking level
5. it can run tools just like a normal agent session
6. its output is streamed into a TUI overlay
7. when you close it, nothing from that exchange is appended to your main session

## Why use it?

`/ooc` is useful when you want to:

- ask a side question without cluttering the main thread
- get a second opinion based on the current context
- inspect the repo or run tools without turning that detour into part of the main conversation
- challenge the current plan
- explore alternatives before committing to a direction
- do a quick isolated investigation and then return to your main flow

## Important behavior

This is the part that matters most:

- the `/ooc` conversation is **not added** to your current session history
- the result is shown **only in the overlay**
- the side-agent has the **same context** as your current session
- the side-agent can use **tools**
- if it uses tools that modify files or run commands, those effects are **real**

So `/ooc` is isolated from your **conversation history**, but not from your **working directory**.

## Closing the overlay

If the side-agent is still running and you press `Esc` or `q`, `pi-ooc` will not close immediately.

Instead it shows a confirmation modal:

- press `Esc` or `q` again to abort and close
- press any other key to keep it running and continue reading

Once the side-agent is finished, `Esc` or `q` closes the overlay normally.

## Keys inside the overlay

- `Esc` or `q` - close
- `↑` / `↓` - scroll
- `PgUp` / `PgDn` - page scroll
- `g` / `G` - jump to top / bottom

## In one sentence

`/ooc` gives you a fully context-aware side-agent in an overlay, without polluting your main session history.

## License

MIT
