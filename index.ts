import { streamSimple, type AssistantMessage, type Message, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@mariozechner/pi-tui";

const COMMAND_NAME = "ooc";
const DEFAULT_OVERLAY_WIDTH = "75%";
const DEFAULT_OVERLAY_MAX_HEIGHT = "80%";

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

class OocOverlay implements Focusable {
  focused = false;

  private answer = "";
  private phase = "Preparing out-of-context request...";
  private detail = "";
  private completed = false;
  private failed = false;
  private followOutput = true;
  private scrollTop = 0;
  private lastContentWidth = 58;
  private disposed = false;

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
    this.detail = this.failed
      ? (message.errorMessage ?? formatUsage(message) ?? "")
      : (formatUsage(message) ?? "");
    if (this.followOutput) {
      this.scrollTop = this.getMaxScroll();
    }
    this.requestRender();
  }

  fail(message: string): void {
    this.completed = true;
    this.failed = true;
    if (!this.answer.trim()) {
      this.answer = message;
    }
    this.phase = "Out-of-context request failed";
    this.detail = message;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      if (!this.completed) this.abort();
      this.close();
      return;
    }

    const page = Math.max(3, this.getBodyHeight() - 1);

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

    if (matchesKey(data, "pageup")) {
      this.followOutput = false;
      this.scrollTop = clamp(this.scrollTop - page, 0, this.getMaxScroll());
      this.requestRender();
      return;
    }

    if (matchesKey(data, "pagedown") || matchesKey(data, "space")) {
      this.scrollTop = clamp(this.scrollTop + page, 0, this.getMaxScroll());
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
    const footerText = [
      "Esc/q close",
      "↑↓ scroll",
      "PgUp/PgDn page",
      contentLines.length > 0 ? `${rangeStart}-${rangeEnd}/${contentLines.length}` : "0/0",
    ].join(" • ");

    const lines: string[] = [];
    lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(this.row(title, innerWidth));
    lines.push(this.row(promptLine, innerWidth));
    lines.push(this.row(statusLine, innerWidth));
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
        : "Waiting for model output...";
    return wrapTextWithAnsi(text, contentWidth);
  }

  private getBodyHeight(): number {
    const terminalRows = this.tui.terminal.rows;
    const overlayRows = Math.max(12, Math.min(terminalRows - 6, Math.floor(terminalRows * 0.7)));
    return Math.max(5, overlayRows - 7);
  }

  private getMaxScroll(): number {
    const lines = this.getContentLines(this.lastContentWidth);
    return Math.max(0, lines.length - this.getBodyHeight());
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
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
    await ctx.waitForIdle();
  }

  if (signal.aborted) return;

  const model = ctx.model;
  if (!model) {
    overlay.fail("No model selected.");
    return;
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (signal.aborted) return;
  if (!apiKey) {
    overlay.fail(`No API key available for ${model.provider}/${model.id}.`);
    return;
  }

  overlay.setPhase("Collecting full session context...");
  const sessionContext = ctx.sessionManager.buildSessionContext();
  if (signal.aborted) return;
  const systemPrompt = ctx.getSystemPrompt();
  const usage = ctx.getContextUsage();
  const contextDetail = usage
    ? `${sessionContext.messages.length} message(s) • approx ${usage.tokens} token(s)`
    : `${sessionContext.messages.length} message(s)`;

  const queryMessage: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const thinkingLevel = pi.getThinkingLevel();
  overlay.setPhase("Asking the model out of context...", contextDetail);

  const responseStream = streamSimple(
    model as Model<any>,
    {
      systemPrompt,
      messages: [...sessionContext.messages, queryMessage],
    },
    {
      apiKey,
      signal,
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      sessionId: `${ctx.sessionManager.getSessionId()}:ooc`,
    },
  );

  try {
    for await (const event of responseStream) {
      if (signal.aborted) return;

      if (event.type === "thinking_start") {
        overlay.setPhase("Model is thinking...", contextDetail);
      } else if (event.type === "text_start") {
        overlay.setPhase("Streaming out-of-context answer...", contextDetail);
      } else if (event.type === "text_delta") {
        overlay.appendText(event.delta);
      } else if (event.type === "error") {
        overlay.fail(event.error.errorMessage ?? "Model returned an error.");
        return;
      }
    }

    const finalMessage = await responseStream.result();
    overlay.finish(finalMessage);
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    overlay.fail(message);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Ask the current model a side question using the full current session context, without adding the exchange to the main session",
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
            () => done(undefined),
            () => controller.abort(),
          );

          void runOutOfContextQuery(ctx, pi, prompt, overlay, controller.signal);
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
