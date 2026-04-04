/**
 * Type declarations for @mariozechner/pi-coding-agent
 * These are stubs for local development. The real types come from the installed package.
 */

declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "turn_start", handler: (event: TurnStartEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "turn_end", handler: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "session_switch", handler: (event: SessionSwitchEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "model_select", handler: (event: ModelSelectEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    registerProvider(name: string, config: ProviderConfig): void;
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
    registerTool<TParams = unknown, TDetails = unknown, TState = unknown>(tool: ToolDefinition<TParams, TDetails, TState>): void;
    registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void;
    registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
    getFlag(name: string): boolean | string | undefined;
    registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    sessionManager: SessionManager;
    model?: { id: string; provider: string };
  }

  export interface ExtensionUIContext {
    theme: Theme;
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type: "info" | "warning" | "error" | "success"): void;
    setFooter(footer: FooterProvider | undefined): void;
  }

  export interface Theme {
    fg(color: ThemeColor, text: string): string;
    bg(color: ThemeColor, text: string): string;
  }

  export type ThemeColor = "dim" | "accent" | "success" | "warning" | "error" | "primary" | "secondary";

  export interface ProviderConfig {
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    authHeader?: boolean;
    streamSimple?: (model: unknown, context: unknown, options?: unknown) => unknown;
    models?: ProviderModelConfig[];
  }

  export interface ProviderModelConfig {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
  }

  export interface RegisteredCommand {
    name: string;
    description?: string;
    handler: (args: string[], ctx: ExtensionContext) => Promise<void> | void;
    sourceInfo?: unknown;
  }

  export interface ToolDefinition<TParams = unknown, TDetails = unknown, TState = unknown> {
    name: string;
    description: string;
    parameters?: TParams;
    handler: (params: unknown, ctx: ExtensionContext) => Promise<ToolResult> | ToolResult;
  }

  export interface ToolResult {
    output?: string;
    error?: string;
  }

  export interface MessageRenderer<T = unknown> {
    render(message: CustomMessage<T>, options?: MessageRenderOptions): string;
  }

  export interface CustomMessage<T = unknown> {
    customType: string;
    content: T;
    display?: string;
    details?: unknown;
  }

  export interface MessageRenderOptions {
    width?: number;
  }

  export interface SessionManager {
    getBranch(): SessionEntry[];
  }

  export interface SessionEntry {
    type: string;
    message?: unknown;
  }

  export interface FooterProvider {
    dispose?: () => void;
    invalidate(): void;
    render(width: number): string[];
  }

  // Event types
  export interface SessionStartEvent {
    type: "session_start";
    reason: "startup" | "reload" | "new" | "resume" | "fork";
    previousSessionFile?: string;
  }

  export interface TurnStartEvent {
    type: "turn_start";
  }

  export interface TurnEndEvent {
    type: "turn_end";
  }

  export interface SessionSwitchEvent {
    type: "session_switch";
    reason: "new" | "switch";
  }

  export interface ModelSelectEvent {
    type: "model_select";
    model: { provider: string; id: string };
    previousModel?: { provider: string; id: string };
    source: "set" | "cycle" | "restore";
  }
}
