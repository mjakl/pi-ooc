import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSessionEvent, type ExtensionAPI, type ExtensionCommandContext, type ExtensionFactory, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";

const COMMAND_NAME = "ooc";
const BLOCKED_TOOLS = new Set(["edit", "write"]);
const BLOCKED_TOOL_REASON =
  "Blocked: /ooc runs a read-only side agent. Describe the change instead of making it.";

// Appended after the question instead of to the system prompt. Providers cache
// the request prefix in the order tools, system prompt, messages, so anything
// added further up would invalidate the main session's cached context and force
// the whole forked history to be processed again.
const SIDE_AGENT_INSTRUCTIONS = `---

How to answer the question above:

- You are an out-of-context side agent. You are not the agent working on this
  session and you are not in charge of it. Answering the question is your only
  job.
- You are read-only. Do not create, change, or delete files. Do not run commands
  that change files, process state, or any external system: no commit, push,
  install, service start or stop, no mutation of external data.
- The edit and write tools are blocked. Bash is available for read-only commands
  only.
- Reading, searching, and any other information gathering is allowed.
- If the question asks for a change, describe the change instead of making it.
- Answer short and to the point: a few sentences or a short list. No preamble, no
  restating of the question, no lengthy explanation unless it is asked for.`;

// Inline extensions are loaded even when extension discovery is off. The guard
// registers no tools and does not touch the system prompt, so blocking mutating
// calls costs nothing from the cached prefix.
const readOnlyGuard: ExtensionFactory = (sidePi) => {
  sidePi.on("tool_call", (event) =>
    BLOCKED_TOOLS.has(event.toolName) ? { block: true, reason: BLOCKED_TOOL_REASON } : undefined,
  );
};

function buildSideAgentPrompt(question: string): string {
  return `${question}\n\n${SIDE_AGENT_INSTRUCTIONS}`;
}

const DEFAULT_OVERLAY_WIDTH = "75%";
const DEFAULT_OVERLAY_MAX_HEIGHT = "80%";
const OVERLAY_HEIGHT_RATIO = 0.8;
const ACTIVITY_HISTORY_LIMIT = 8;
const ACTIVITY_VISIBLE_ROWS = 3;
const INFO_PANEL_ROWS = 1 + ACTIVITY_VISIBLE_ROWS;
const CLOSE_CONFIRMATION_MODAL_ROWS = 5;

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function formatUsage(message: AssistantMessage): string | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return `tokens in/out ${usage.input}/${usage.output} • total ${usage.totalTokens}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function padVisible(text: string, width: number): string {
  const safe = truncateToWidth(text, width, "");
  return safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
}

function centerVisible(text: string, width: number): string {
  const safe = truncateToWidth(text, width, "");
  const remaining = Math.max(0, width - visibleWidth(safe));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return " ".repeat(left) + safe + " ".repeat(right);
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

function findLastAssistantMessage(messages: unknown[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message)) return message;
  }
  return undefined;
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";

  if (toolName === "bash" && typeof args.command === "string") {
    return truncateToWidth(args.command, 100);
  }

  if (typeof args.path === "string") {
    return truncateToWidth(args.path, 100);
  }

  if (typeof args.pattern === "string") {
    return truncateToWidth(args.pattern, 100);
  }

  try {
    return truncateToWidth(JSON.stringify(args), 100);
  } catch {
    return "";
  }
}

function buildContextDetail(messageCount: number, tokens?: number): string {
  return tokens !== undefined
    ? `${messageCount} message(s) • approx ${tokens} token(s) • read-only, edit/write blocked`
    : `${messageCount} message(s) • read-only, edit/write blocked`;
}

function describeToolActivity(toolName: string, args: Record<string, unknown> | undefined): string {
  const summary = summarizeToolArgs(toolName, args);
  return summary ? `${toolName}: ${summary}` : toolName;
}

interface SideSessionHandle {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  cleanup(): Promise<void>;
}

async function removeTempDir(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { recursive: true, force: true });
}

class OocOverlay implements Focusable {
  focused = false;

  private answer = "";
  private phase = "Preparing isolated side agent...";
  private detail = "";
  private completed = false;
  private failed = false;
  private followOutput = true;
  private scrollTop = 0;
  private lastContentWidth = 58;
  private disposed = false;
  private cachedContentWidth = -1;
  private cachedContentText = "";
  private cachedContentLines: string[] = [];
  private currentAction = "Preparing isolated side agent...";
  private activity: string[] = [];
  private closeConfirmationPending = false;
  private closeConfirmationRestore: { phase: string; detail: string } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly modelLabel: string,
    private readonly prompt: string,
    private readonly close: () => void,
    private readonly abort: () => void,
  ) {}

  setPhase(phase: string, detail?: string): void {
    this.phase = phase;
    if (detail !== undefined) this.detail = detail;
    if (this.completed) {
      this.closeConfirmationPending = false;
      this.closeConfirmationRestore = undefined;
    }
    this.requestRender();
  }

  setCurrentAction(action: string): void {
    this.currentAction = action;
    this.requestRender();
  }

  addActivity(message: string): void {
    const entry = message.trim();
    if (!entry) return;
    if (this.activity[this.activity.length - 1] === entry) return;
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_HISTORY_LIMIT) {
      this.activity.splice(0, this.activity.length - ACTIVITY_HISTORY_LIMIT);
    }
    this.requestRender();
  }

  updateActivity(action: string, message?: string): void {
    this.currentAction = action;
    if (message) {
      const entry = message.trim();
      if (entry && this.activity[this.activity.length - 1] !== entry) {
        this.activity.push(entry);
        if (this.activity.length > ACTIVITY_HISTORY_LIMIT) {
          this.activity.splice(0, this.activity.length - ACTIVITY_HISTORY_LIMIT);
        }
      }
    }
    this.requestRender();
  }

  appendText(delta: string): void {
    this.answer += delta;
    if (this.followOutput) {
      this.scrollTop = this.getMaxScroll();
    }
    this.requestRender();
  }

  finish(message: AssistantMessage): void {
    const finalText = extractText(message);
    if (finalText && finalText !== this.answer) {
      this.answer = finalText;
    }
    this.completed = true;
    this.failed = message.stopReason === "error";
    this.phase = this.failed ? "Out-of-context request failed" : "Out-of-context response ready";
    this.currentAction = this.failed ? "failed" : "done";
    this.closeConfirmationPending = false;
    this.closeConfirmationRestore = undefined;
    this.detail = this.failed
      ? (message.errorMessage ?? formatUsage(message) ?? "")
      : (formatUsage(message) ?? "");
    if (this.followOutput) {
      this.scrollTop = this.getMaxScroll();
    }
    this.requestRender();
  }

  complete(detail = ""): void {
    this.completed = true;
    this.failed = false;
    this.phase = "Out-of-context response ready";
    this.currentAction = "done";
    this.closeConfirmationPending = false;
    this.closeConfirmationRestore = undefined;
    this.detail = detail;
    if (this.followOutput) {
      this.scrollTop = this.getMaxScroll();
    }
    this.requestRender();
  }

  fail(message: string): void {
    this.completed = true;
    this.failed = true;
    this.currentAction = "failed";
    this.closeConfirmationPending = false;
    this.closeConfirmationRestore = undefined;
    if (!this.answer.trim()) {
      this.answer = message;
    }
    this.phase = "Out-of-context request failed";
    this.detail = message;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      if (!this.completed) {
        if (!this.closeConfirmationPending) {
          this.closeConfirmationPending = true;
          this.closeConfirmationRestore = { phase: this.phase, detail: this.detail };
          this.setPhase("Side agent still running", "Press Esc or q again to abort and close");
          this.addActivity("close requested while side agent was still running");
          return;
        }
        this.abort();
      }
      this.close();
      return;
    }

    if (this.closeConfirmationPending) {
      const restore = this.closeConfirmationRestore;
      this.closeConfirmationPending = false;
      this.closeConfirmationRestore = undefined;
      if (restore) {
        this.setPhase(restore.phase, restore.detail);
      }
    }

    if (matchesKey(data, "up") || data === "k") {
      this.followOutput = false;
      this.scrollTop = clamp(this.scrollTop - 1, 0, this.getMaxScroll());
      this.requestRender();
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      this.scrollTop = clamp(this.scrollTop + 1, 0, this.getMaxScroll());
      this.followOutput = this.scrollTop >= this.getMaxScroll();
      this.requestRender();
      return;
    }

    if (matchesKey(data, "home") || data === "g") {
      this.followOutput = false;
      this.scrollTop = 0;
      this.requestRender();
      return;
    }

    if (matchesKey(data, "end") || data === "G") {
      this.scrollTop = this.getMaxScroll();
      this.followOutput = true;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const bodyHeight = this.getBodyHeight();
    const contentWidth = Math.max(10, innerWidth - 2);
    this.lastContentWidth = contentWidth;
    const contentLines = this.getContentLines(contentWidth);
    const maxScroll = Math.max(0, contentLines.length - bodyHeight);
    this.scrollTop = clamp(this.scrollTop, 0, maxScroll);
    if (this.followOutput) this.scrollTop = maxScroll;

    const visibleLines = contentLines.slice(this.scrollTop, this.scrollTop + bodyHeight);
    while (visibleLines.length < bodyHeight) visibleLines.push("");

    const title = this.theme.fg("accent", this.theme.bold(` OOC • ${this.modelLabel} `));
    const promptLine = truncateToWidth(
      `${this.theme.fg("muted", "Question:")} ${this.prompt}`,
      innerWidth,
    );

    const phaseColor = this.failed ? "error" : this.completed ? "success" : "warning";
    let statusLine = this.theme.fg(phaseColor, this.phase);
    if (this.detail) {
      statusLine += this.theme.fg("dim", ` • ${this.detail}`);
    }
    statusLine = truncateToWidth(statusLine, innerWidth);

    const rangeStart = contentLines.length === 0 ? 0 : this.scrollTop + 1;
    const rangeEnd = Math.min(contentLines.length, this.scrollTop + bodyHeight);
    const footerText = this.closeConfirmationPending
      ? [
          "Esc/q again abort+close",
          "Any other key continue",
          contentLines.length > 0 ? `${rangeStart}-${rangeEnd}/${contentLines.length}` : "0/0",
        ].join(" • ")
      : [
          "Esc/q close",
          "↑↓ scroll",
          "g/G top/bottom",
          contentLines.length > 0 ? `${rangeStart}-${rangeEnd}/${contentLines.length}` : "0/0",
        ].join(" • ");

    const currentActionLine = truncateToWidth(
      `${this.theme.fg("muted", "Now:")} ${this.currentAction || "idle"}`,
      innerWidth,
    );
    const recentActivity = this.activity.slice(-ACTIVITY_VISIBLE_ROWS).reverse();

    const lines: string[] = [];
    lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(this.row(title, innerWidth));
    lines.push(this.row(promptLine, innerWidth));
    lines.push(this.row(statusLine, innerWidth));
    if (this.closeConfirmationPending) {
      lines.push(this.row("", innerWidth));
      lines.push(this.row(centerVisible(this.theme.fg("warning", this.theme.bold("Side agent still running")), innerWidth), innerWidth));
      lines.push(this.row(centerVisible(this.theme.fg("warning", "Press Esc or q again to abort and close"), innerWidth), innerWidth));
      lines.push(this.row(centerVisible(this.theme.fg("dim", "Press any other key to continue"), innerWidth), innerWidth));
      lines.push(this.row("", innerWidth));
    } else {
      lines.push(this.row(currentActionLine, innerWidth));
      for (let i = 0; i < ACTIVITY_VISIBLE_ROWS; i++) {
        const entry = recentActivity[i];
        const prefix = i === 0 ? "Recent:" : "       ";
        const line = entry
          ? `${this.theme.fg("muted", prefix)} ${entry}`
          : this.theme.fg("dim", i === 0 ? "Recent: -" : "");
        lines.push(this.row(truncateToWidth(line, innerWidth), innerWidth));
      }
    }
    lines.push(this.row("", innerWidth));

    for (const line of visibleLines) {
      lines.push(this.row(line, innerWidth));
    }

    lines.push(this.row("", innerWidth));
    lines.push(this.row(this.theme.fg("dim", truncateToWidth(footerText, innerWidth)), innerWidth));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
  }

  private row(content: string, innerWidth: number): string {
    return (
      this.theme.fg("border", "│") +
      padVisible(content, innerWidth) +
      this.theme.fg("border", "│")
    );
  }

  private getContentLines(contentWidth: number): string[] {
    const text = this.answer.trim().length > 0
      ? this.answer
      : this.completed
        ? "(No text output.)"
        : "Waiting for side-agent output...";

    if (this.cachedContentWidth !== contentWidth || this.cachedContentText !== text) {
      this.cachedContentWidth = contentWidth;
      this.cachedContentText = text;
      this.cachedContentLines = wrapTextWithAnsi(text, contentWidth);
    }

    return this.cachedContentLines;
  }

  private getBodyHeight(): number {
    const terminalRows = this.tui.terminal.rows;
    const overlayRows = Math.max(12, Math.min(terminalRows - 6, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO)));
    const panelRows = this.closeConfirmationPending ? CLOSE_CONFIRMATION_MODAL_ROWS : INFO_PANEL_ROWS;
    const extraRows = 8 + panelRows;
    return Math.max(4, overlayRows - extraRows);
  }

  private getMaxScroll(): number {
    const lines = this.getContentLines(this.lastContentWidth);
    return Math.max(0, lines.length - this.getBodyHeight());
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }
}

async function createIsolatedSideSession(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<SideSessionHandle> {
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  let tempDir: string | undefined;

  try {
    let sessionManager = SessionManager.inMemory(ctx.cwd);
    let forked = false;
    if (sourceSessionFile) {
      tempDir = await mkdtemp(join(tmpdir(), "pi-ooc-"));
      try {
        sessionManager = SessionManager.forkFrom(sourceSessionFile, ctx.cwd, tempDir);
        forked = true;
      } catch {
        // A session file that has nothing written to it yet cannot be forked,
        // which is the case for the first command of a fresh session. Seed the
        // side session from the parent's in-memory context instead.
        await removeTempDir(tempDir);
        tempDir = undefined;
      }
    }

    // Side sessions are short-lived. Do not load extensions whose asynchronous
    // work could outlive the session and call into an invalidated context.
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      extensionFactories: [readOnlyGuard],
    });
    await resourceLoader.reload();

    // No model runtime is passed: pi builds its own from the same agent dir the
    // main session uses, and the extension context only exposes the synchronous
    // registry, which is no longer accepted here.
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      model: ctx.model ?? undefined,
      thinkingLevel: pi.getThinkingLevel(),
      sessionManager,
      resourceLoader,
    });

    if (!forked) {
      const parentContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      );
      session.agent.state.messages = parentContext.messages;
    }

    return {
      session,
      cleanup: async () => {
        try {
          await session.abort();
        } catch {
          // Ignore cleanup abort errors.
        }
        session.dispose();
        await removeTempDir(tempDir);
      },
    };
  } catch (error) {
    await removeTempDir(tempDir);
    throw error;
  }
}

async function runOutOfContextQuery(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  prompt: string,
  overlay: OocOverlay,
  signal: AbortSignal,
): Promise<void> {
  if (ctx.hasPendingMessages()) {
    overlay.setPhase("Waiting for the main agent to become idle...");
    overlay.updateActivity("waiting for the main agent to become idle", "waiting for main agent to become idle");
    await ctx.waitForIdle();
  }

  if (signal.aborted) return;

  if (!ctx.model) {
    overlay.fail("No model selected.");
    return;
  }

  const parentContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const usage = ctx.getContextUsage();
  const contextTokens = usage?.tokens ?? undefined;
  const contextDetail = buildContextDetail(parentContext.messages.length, contextTokens);

  overlay.setPhase("Preparing isolated side agent...", contextDetail);
  overlay.updateActivity("preparing isolated side agent", "created isolated side-agent context");

  const { session, cleanup } = await createIsolatedSideSession(ctx, pi);
  let finalMessage: AssistantMessage | undefined;
  let turnNumber = 0;
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (signal.aborted) return;

    if (event.type === "turn_start") {
      turnNumber += 1;
      overlay.updateActivity(`starting turn ${turnNumber}`, `turn ${turnNumber} started`);
      return;
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start") {
        overlay.setPhase("Side agent is thinking...", contextDetail);
        overlay.updateActivity("thinking", "assistant is thinking");
      } else if (update.type === "text_start") {
        overlay.setPhase("Streaming side-agent answer...", contextDetail);
        overlay.updateActivity("writing answer", "assistant started writing the answer");
      } else if (update.type === "text_delta") {
        overlay.setCurrentAction("writing answer");
        overlay.appendText(update.delta);
      } else if (update.type === "error") {
        overlay.fail(update.error?.errorMessage ?? "Side agent failed.");
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      toolArgsByCallId.set(event.toolCallId, event.args);
      const toolActivity = describeToolActivity(event.toolName, event.args);
      overlay.setPhase(`Running ${event.toolName}...`, summarizeToolArgs(event.toolName, event.args) || contextDetail);
      overlay.updateActivity(toolActivity, toolActivity);
      return;
    }

    if (event.type === "tool_execution_update") {
      overlay.setCurrentAction(`working in ${event.toolName}`);
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolArgs = toolArgsByCallId.get(event.toolCallId);
      toolArgsByCallId.delete(event.toolCallId);
      const toolActivity = describeToolActivity(event.toolName, toolArgs);
      const detail = event.isError ? `tool ${event.toolName} failed` : contextDetail;
      overlay.setPhase(
        event.isError ? `${event.toolName} failed` : `Completed ${event.toolName}`,
        detail,
      );
      overlay.updateActivity(
        event.isError ? `${event.toolName} failed` : "waiting for the next step",
        event.isError ? `${toolActivity} (failed)` : `${toolActivity} (done)`,
      );
      return;
    }

    if (event.type === "turn_end") {
      const label = turnNumber > 0 ? `turn ${turnNumber}` : "turn";
      overlay.updateActivity("deciding next step", `${label} finished`);
      return;
    }

    if (event.type === "compaction_start" && (event.reason === "threshold" || event.reason === "overflow")) {
      overlay.setPhase("Compacting side-agent context...", contextDetail);
      overlay.updateActivity("compacting context", "compacting side-agent context");
      return;
    }

    if (event.type === "auto_retry_start") {
      overlay.setPhase(
        "Retrying after transient error...",
        `attempt ${event.attempt}/${event.maxAttempts}`,
      );
      overlay.updateActivity(
        `retrying after transient error (attempt ${event.attempt}/${event.maxAttempts})`,
        `retry ${event.attempt}/${event.maxAttempts} scheduled`,
      );
      return;
    }

    if (event.type === "auto_retry_end") {
      if (event.success) {
        overlay.setPhase("Running isolated side agent...", contextDetail);
        overlay.updateActivity("resuming after retry", `retry attempt ${event.attempt} succeeded`);
      } else {
        overlay.setPhase("Out-of-context request failed", event.finalError ?? "retry attempts exhausted");
        overlay.updateActivity("retry attempts exhausted", event.finalError ?? "side agent retry attempts exhausted");
      }
      return;
    }

    if (event.type === "agent_end") {
      finalMessage = findLastAssistantMessage(event.messages ?? []);
      overlay.updateActivity("finishing response", "side agent finished");
    }
  });

  signal.addEventListener("abort", () => {
    void session.abort();
  }, { once: true });

  try {
    overlay.setPhase("Running isolated side agent...", contextDetail);
    overlay.updateActivity("running isolated side agent", "prompt sent to side agent");
    if (signal.aborted) return;
    await session.prompt(buildSideAgentPrompt(prompt));
    if (signal.aborted) return;

    finalMessage ??= findLastAssistantMessage(session.messages ?? []);

    if (finalMessage) {
      overlay.finish(finalMessage);
    } else {
      overlay.complete();
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    overlay.fail(message);
  } finally {
    unsubscribe();
    await cleanup();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Ask a side question in an isolated agent session seeded with the current session context; the exchange stays out of the main session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        console.error(`/${COMMAND_NAME} requires a UI-capable mode.`);
        return;
      }

      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify(`Usage: /${COMMAND_NAME} <question>`, "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const controller = new AbortController();
          const overlay = new OocOverlay(
            tui,
            theme,
            `${ctx.model!.provider}/${ctx.model!.id}`,
            prompt,
            () => {
              overlay.dispose();
              done(undefined);
            },
            () => controller.abort(),
          );

          void runOutOfContextQuery(ctx, pi, prompt, overlay, controller.signal)
            .catch((error) => {
              if (controller.signal.aborted) return;
              const message = error instanceof Error ? error.message : String(error);
              overlay.fail(message);
            });
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: DEFAULT_OVERLAY_WIDTH,
            maxHeight: DEFAULT_OVERLAY_MAX_HEIGHT,
            minWidth: 60,
            anchor: "center",
            margin: 1,
          },
        },
      );
    },
  });
}
