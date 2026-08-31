import type {
  ProjectDocument,
  ActivationApproval,
  ActiveProjectState,
  SessionSnapshot,
} from "./types";
import {
  cloneProject,
  matchesSiteScope,
  projectFingerprint,
  isToolAvailable,
  validateProject,
} from "./validation";

export class ProjectActivationError extends Error {
  readonly code:
    | "invalid_project"
    | "invalid_approval"
    | "snapshot_mismatch"
    | "tab_mismatch"
    | "origin_mismatch"
    | "scope_blocked"
    | "session_unverified";

  constructor(code: ProjectActivationError["code"], message: string) {
    super(message);
    this.name = "ProjectActivationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function currentOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function parseApproval(value: unknown): ActivationApproval {
  if (!isRecord(value))
    throw new ProjectActivationError(
      "invalid_approval",
      "Activation approval must be an object.",
    );
  if (
    typeof value.snapshotHash !== "string" ||
    typeof value.approvedAt !== "number" ||
    !Number.isFinite(value.approvedAt) ||
    typeof value.tabId !== "number" ||
    !Number.isSafeInteger(value.tabId) ||
    value.tabId < 0 ||
    typeof value.origin !== "string" ||
    typeof value.allowConsequential !== "boolean" ||
    (value.sessionVerified !== undefined &&
      typeof value.sessionVerified !== "boolean")
  )
    throw new ProjectActivationError(
      "invalid_approval",
      "Activation approval is malformed.",
    );
  return value as unknown as ActivationApproval;
}

export function createActivationApproval(
  project: ProjectDocument,
  tabId: number,
  url: string,
  allowConsequential = false,
  sessionVerified = false,
): ActivationApproval {
  const origin = currentOrigin(url);
  if (!origin)
    throw new ProjectActivationError(
      "origin_mismatch",
      "The target tab has no HTTP origin.",
    );
  return {
    snapshotHash: projectFingerprint(project),
    approvedAt: Date.now(),
    tabId,
    origin,
    allowConsequential,
    ...(project.tools.some(
      (tool) => tool.enabled && tool.access === "authenticated",
    )
      ? { sessionVerified }
      : {}),
  };
}

/** Validate every activation invariant before a page-side registration occurs. */
export function validateActivation(
  projectValue: unknown,
  approvalValue: unknown,
  tabId: number,
  url: string,
  session?: SessionSnapshot,
): {
  project: ProjectDocument;
  approval: ActivationApproval;
  active: ActiveProjectState;
} {
  let project: ProjectDocument;
  try {
    project = cloneProject(
      validateProject(projectValue, { requireRunnable: true }),
    );
  } catch (error) {
    throw new ProjectActivationError(
      "invalid_project",
      error instanceof Error ? error.message : "The project is not runnable.",
    );
  }
  const approval = parseApproval(approvalValue);
  const hash = projectFingerprint(project);
  if (approval.snapshotHash !== hash)
    throw new ProjectActivationError(
      "snapshot_mismatch",
      "Approval is for a different project snapshot; review the current revision again.",
    );
  if (approval.tabId !== tabId)
    throw new ProjectActivationError(
      "tab_mismatch",
      "Approval is bound to a different browser tab.",
    );
  const origin = currentOrigin(url);
  if (!origin || approval.origin !== origin)
    throw new ProjectActivationError(
      "origin_mismatch",
      "Approval is bound to a different page origin.",
    );
  if (!matchesSiteScope(project, url))
    throw new ProjectActivationError(
      "scope_blocked",
      "The selected tab is outside the project's approved site scope.",
    );
  if (
    project.tools.some(
      (tool) =>
        tool.enabled &&
        tool.access === "authenticated" &&
        !isToolAvailable(project, tool.id, session),
    ) &&
    (approval.sessionVerified !== true ||
      (session !== undefined && session.status !== "authenticated") ||
      (session !== undefined && !session.verified))
  )
    throw new ProjectActivationError(
      "session_unverified",
      "A human must verify the signed-in session before protected tools can be activated.",
    );
  return {
    project,
    approval,
    active: {
      projectId: project.project.id,
      revision: project.project.revision,
      snapshotHash: hash,
      tabId,
      origin,
      runtimeGeneration: "pending",
      approved: true,
      toolNames: project.tools
        .filter((tool) => tool.enabled)
        .map((tool) => tool.name),
    },
  };
}
