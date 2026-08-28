import type { Capability, JSONSchema, NativeToolSummary } from "../types";

/**
 * The subset of MCP annotations that is useful to a browser-native tool
 * consumer.  Annotations are deliberately optional because older hosts may
 * reject unknown metadata rather than ignoring it.
 */
export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A JSON-serializable tool description.  `execute` is intentionally absent:
 * functions cannot cross the isolated-world bridge and are attached by the
 * MAIN-world runtime when a tool is registered.
 */
export interface WebMcpToolDescriptor {
  capabilityId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: WebMcpToolAnnotations;
}

/** Spelling alias for consumers that use the all-caps acronym. */
export type WebMCPToolDescriptor = WebMcpToolDescriptor;

export type NativeToolInput = NativeToolSummary | string;

export interface CompilerOptions {
  nativeTools?: Iterable<NativeToolInput>;
  nativeToolNames?: Iterable<string>;
  includeDisabled?: boolean;
}

export type CompilationSkipReason =
  "disabled" | "native-equivalent" | "duplicate-name" | "invalid";

export interface CompilationSkip {
  capability: Capability;
  reason: CompilationSkipReason;
  detail: string;
}

export interface CompilationResult {
  tools: WebMcpToolDescriptor[];
  skipped: CompilationSkip[];
}
