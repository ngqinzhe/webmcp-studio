export interface ExternalDiscoveryTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  source?: "webmcp" | "dom" | "manual";
  confidence?: number;
  evidence?: Array<{
    type: "dom" | "action" | "manual";
    note: string;
    selector?: string;
  }>;
}

export interface ExternalInspectionResult {
  status: "inspected" | "no_tools" | "blocked" | "error";
  url: string;
  title: string;
  tools: ExternalDiscoveryTool[];
  frame: {
    status: "allowed" | "blocked" | "unknown";
    reason: string;
  };
  note: string;
  error?: string;
}

export function validateExternalUrl(
  rawUrl: string,
  options?: { requireHttps?: boolean },
): URL;
export function analyzeExternalHtml(input: {
  url: string;
  html: string;
  status?: number;
  contentType?: string;
  headers?: Headers;
  studioOrigin?: string;
}): ExternalInspectionResult;
export function inspectExternalSite(
  url: string,
  options?: {
    fetchImpl?: typeof fetch;
    studioOrigin?: string;
    requireHttps?: boolean;
  },
): Promise<ExternalInspectionResult>;
export function handleExternalDiscovery(request: Request): Promise<Response>;
