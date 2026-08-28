import type {
  Capability,
  ExecutionError,
  ExecutionFailureCode,
  ExecutionResult,
  ExecutorDefinition,
  ExpectedOutcome,
  JSONSchema,
  JsonValue,
  SemanticLocator,
} from "../types";
import {
  describeElement,
  getAccessibleName,
  getSemanticRole,
  isClickableElement,
  resolveSemanticLocator,
} from "../locators";
import {
  callNativeMethod,
  controlKind,
  dispatchDomEvent,
  isDisabledElement,
  isVisibleElement,
  readChecked,
  readControlValue,
  readNativeProperty,
  readSelectedValues,
  setNativeProperty,
} from "./dom";
import {
  hasExplicitOutcomePredicate,
  matchesExpectedOutcome,
  navigationOccurred,
  observableStateChanged,
  snapshotPage,
  type ExecutionSnapshot,
} from "./snapshot";

export interface ExecutionOptions {
  document?: Document;
  /** Optional location source for test DOMs and embedded documents. */
  urlProvider?: () => string;
  /** Maximum bounded wait for asynchronous DOM/navigation outcomes. */
  timeoutMs?: number;
  /** Polling/settling cadence. It is never used as an unbounded sleep. */
  settleMs?: number;
}

interface OperationError {
  code: ExecutionFailureCode;
  message: string;
  details?: Record<string, JsonValue>;
}

interface WaitOutcome {
  after: ExecutionSnapshot;
  satisfied: boolean;
  timedOut: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getDocument(options: ExecutionOptions): Document | null {
  if (options.document) return options.document;
  try {
    return typeof document === "undefined" ? null : document;
  } catch {
    return null;
  }
}

function emptySnapshot(): ExecutionSnapshot {
  return {
    url: "",
    title: "",
    text: "",
    state: "",
    controls: [],
    frameUrls: [],
  };
}

function captureSnapshot(
  document: Document,
  options: ExecutionOptions,
): ExecutionSnapshot {
  try {
    return snapshotPage(document, options.urlProvider);
  } catch {
    return emptySnapshot();
  }
}

function unexpectedOperationError(error: unknown): OperationError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: /timeout/i.test(message)
      ? "execution_timeout"
      : /valid|submit|constraint/i.test(message)
        ? "validation_failed"
        : "unsupported_control",
    message: message || "The DOM operation failed unexpectedly.",
  };
}

function errorDetails(
  resolutionStatus: string,
  candidateCount: number,
  reason: string | undefined,
): Record<string, JsonValue> {
  const details: Record<string, JsonValue> = {
    resolutionStatus,
    candidateCount,
  };
  if (reason) details.reason = reason;
  return details;
}

function failureResult(
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
  error: OperationError,
  matchedTarget?: string,
  warnings: string[] = [],
): ExecutionResult {
  const result: ExecutionResult = {
    success: false,
    status: error.code,
    urlBefore: before.url,
    urlAfter: after.url,
    navigationOccurred: navigationOccurred(before, after),
    stateChanged: observableStateChanged(before, after),
    warnings,
    error: {
      code: error.code,
      message: error.message,
    },
  };
  if (matchedTarget) result.matchedTarget = matchedTarget;
  if (error.details) (result.error as ExecutionError).details = error.details;
  return result;
}

function completedResult(
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
  resultValue?: JsonValue,
  matchedTarget?: string,
  warnings: string[] = [],
): ExecutionResult {
  const result: ExecutionResult = {
    success: true,
    status: "completed",
    urlBefore: before.url,
    urlAfter: after.url,
    navigationOccurred: navigationOccurred(before, after),
    stateChanged: observableStateChanged(before, after),
    warnings,
  };
  if (matchedTarget) result.matchedTarget = matchedTarget;
  if (resultValue !== undefined) result.result = resultValue;
  return result;
}

function resolveTarget(
  document: Document,
  locator: SemanticLocator,
): { element: Element; description: string } | { error: OperationError } {
  const resolution = resolveSemanticLocator(document, locator);
  if (resolution.status !== "matched" || !resolution.element) {
    const code: ExecutionFailureCode =
      resolution.status === "ambiguous"
        ? "ambiguous_target"
        : resolution.status === "cross_origin_blocked"
          ? "cross_origin_blocked"
          : "target_not_found";
    return {
      error: {
        code,
        message:
          resolution.reason ??
          (code === "ambiguous_target"
            ? "More than one target matched the semantic locator."
            : "The target could not be found."),
        details: errorDetails(
          resolution.status,
          resolution.candidates.length,
          resolution.reason,
        ),
      },
    };
  }
  return {
    element: resolution.element,
    description: describeElement(resolution.element),
  };
}

function checkVisibleAndEnabled(element: Element): OperationError | null {
  if (!isVisibleElement(element)) {
    return {
      code: "unsupported_control",
      message:
        "The matched control is hidden and cannot be operated through visible UI.",
    };
  }
  if (isDisabledElement(element)) {
    return {
      code: "unsupported_control",
      message: "The matched control is disabled.",
    };
  }
  return null;
}

function valueAsString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function dispatchInputAndChange(element: Element): void {
  dispatchDomEvent(element, "input");
  dispatchDomEvent(element, "change");
}

function controlInvalidity(element: Element): OperationError | null {
  const validity = callNativeMethod(element, "checkValidity");
  if (validity.ok && validity.value === false) {
    return {
      code: "validation_failed",
      message:
        "The control rejected the supplied value according to browser validation.",
    };
  }
  return null;
}

function setTextControl(
  element: Element,
  value: unknown,
  validate: boolean,
): OperationError | null {
  const stringValue = valueAsString(value);
  if (stringValue === null) {
    return {
      code: "invalid_arguments",
      message: "Text controls require a string or finite number value.",
    };
  }

  const tagName = element.localName.toLowerCase();
  const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
  if (
    tagName === "input" &&
    [
      "hidden",
      "file",
      "button",
      "submit",
      "reset",
      "image",
      "checkbox",
      "radio",
    ].includes(inputType)
  ) {
    return {
      code: "unsupported_control",
      message: `Input type ${inputType} is not a text-editable control.`,
    };
  }
  if (element.hasAttribute("readonly")) {
    return {
      code: "unsupported_control",
      message: "Read-only controls cannot be populated through visible UI.",
    };
  }

  if (!setNativeProperty(element, "value", stringValue)) {
    return {
      code: "unsupported_control",
      message: "The control does not expose a writable native value property.",
    };
  }
  dispatchInputAndChange(element);
  return validate ? controlInvalidity(element) : null;
}

function optionValue(option: Element): string {
  const value = readNativeProperty(option, "value");
  if (typeof value === "string") return value;
  return option.getAttribute("value") ?? option.textContent?.trim() ?? "";
}

function setSelectControl(
  element: Element,
  value: unknown,
  validate: boolean,
): OperationError | null {
  const options = Array.from(element.querySelectorAll("option"));
  const availableValues = options.map(optionValue);
  const multiple = element.hasAttribute("multiple");
  let requested: string[];

  if (multiple) {
    if (!Array.isArray(value)) {
      return {
        code: "invalid_arguments",
        message: "Multiple selects require an array of option values.",
      };
    }
    const converted = value.map(valueAsString);
    if (converted.some((item): item is null => item === null)) {
      return {
        code: "invalid_arguments",
        message: "Select option values must be strings or finite numbers.",
      };
    }
    requested = converted as string[];
  } else {
    const converted = valueAsString(value);
    if (converted === null) {
      return {
        code: "invalid_arguments",
        message: "A select requires one string or finite number option value.",
      };
    }
    requested = [converted];
  }

  if (requested.some((item) => !availableValues.includes(item))) {
    return {
      code: "invalid_arguments",
      message: "One or more requested select options do not exist.",
      details: { requested, available: availableValues },
    };
  }

  for (const option of options) {
    const shouldSelect = requested.includes(optionValue(option));
    if (!setNativeProperty(option, "selected", shouldSelect)) {
      return {
        code: "unsupported_control",
        message:
          "The select option does not expose a writable selected property.",
      };
    }
  }
  if (!multiple && requested[0] !== undefined) {
    setNativeProperty(element, "value", requested[0]);
  }
  dispatchInputAndChange(element);
  return validate ? controlInvalidity(element) : null;
}

function setCheckableControl(
  element: Element,
  kind: "checkbox" | "radio",
  value: unknown,
): OperationError | null {
  let target = element;
  let desired: boolean;
  if (kind === "radio" && typeof value === "string") {
    const name = element.getAttribute("name");
    let root: Document | ShadowRoot | null = null;
    try {
      const candidateRoot = element.getRootNode();
      if (candidateRoot.nodeType === 9 || candidateRoot.nodeType === 11) {
        root = candidateRoot as Document | ShadowRoot;
      }
    } catch {
      root = element.ownerDocument;
    }
    const radios = root
      ? Array.from(root.querySelectorAll('input[type="radio"]')).filter(
          (candidate) => !name || candidate.getAttribute("name") === name,
        )
      : [element];
    const radioValue = (candidate: Element): string => {
      const nativeValue = readNativeProperty(candidate, "value");
      return typeof nativeValue === "string"
        ? nativeValue
        : (candidate.getAttribute("value") ?? "");
    };
    const selected = radios.find(
      (candidate) => radioValue(candidate) === value,
    );
    if (!selected) {
      return {
        code: "invalid_arguments",
        message:
          "The supplied radio value does not identify an available option.",
      };
    }
    target = selected;
    desired = true;
  } else if (typeof value === "boolean") {
    desired = value;
  } else {
    return {
      code: "invalid_arguments",
      message: `${kind} controls require a boolean value.`,
    };
  }

  const targetError = checkVisibleAndEnabled(target);
  if (targetError) return targetError;
  const current = readChecked(target);
  if (current === desired) return null;
  if (kind === "radio" && !desired) {
    return {
      code: "unsupported_control",
      message: "A radio control cannot be unchecked through normal visible UI.",
    };
  }

  const click = callNativeMethod(target, "click");
  if (!click.ok) {
    if (!setNativeProperty(target, "checked", desired)) {
      return {
        code: "unsupported_control",
        message: "The checkable control has no native click or checked setter.",
      };
    }
    dispatchInputAndChange(target);
  }

  return null;
}

function applyControlValue(
  element: Element,
  expectedKind: "input" | "textarea" | "select" | "checkbox" | "radio",
  value: unknown,
  validate: boolean,
): OperationError | null {
  const actualKind = controlKind(element);
  if (actualKind !== expectedKind) {
    return {
      code: "unsupported_control",
      message: `The locator resolved ${actualKind ?? "an unsupported element"}, expected ${expectedKind}.`,
    };
  }

  switch (expectedKind) {
    case "input":
    case "textarea":
      return setTextControl(element, value, validate);
    case "select":
      return setSelectControl(element, value, validate);
    case "checkbox":
    case "radio":
      return setCheckableControl(element, expectedKind, value);
    default:
      return {
        code: "unsupported_control",
        message: `Control kind ${expectedKind} is not supported.`,
      };
  }
}

function argsObjectError(args: unknown): OperationError | null {
  return isRecord(args)
    ? null
    : {
        code: "invalid_arguments",
        message: "Capability arguments must be a JSON object.",
      };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function expectedOrEmpty(
  expected: ExpectedOutcome | undefined,
): ExpectedOutcome {
  return expected ?? {};
}

function boundedTimeout(
  expected: ExpectedOutcome,
  options: ExecutionOptions,
): number {
  const requested = expected.waitMs ?? options.timeoutMs ?? 750;
  if (!Number.isFinite(requested)) return 750;
  return Math.max(0, Math.min(10_000, requested));
}

async function waitForOutcome(
  document: Document,
  before: ExecutionSnapshot,
  expected: ExpectedOutcome,
  options: ExecutionOptions,
): Promise<WaitOutcome> {
  const evaluate = (): WaitOutcome => {
    const after = snapshotPage(document, options.urlProvider);
    return {
      after,
      satisfied: matchesExpectedOutcome(document, before, after, expected),
      timedOut: false,
    };
  };

  const initial = evaluate();
  if (initial.satisfied) return initial;

  const timeoutMs = boundedTimeout(expected, options);
  if (timeoutMs === 0) return { ...initial, timedOut: true };

  const pollMs = Math.max(5, Math.min(250, options.settleMs ?? 25));
  return new Promise<WaitOutcome>((resolve) => {
    let finished = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;

    const finish = (outcome: WaitOutcome): void => {
      if (finished) return;
      finished = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      observer?.disconnect();
      resolve(outcome);
    };

    const check = (): void => {
      const outcome = evaluate();
      if (outcome.satisfied) finish(outcome);
    };

    const Observer = document.defaultView?.MutationObserver;
    const observationTarget = document.documentElement ?? document.body;
    if (Observer && observationTarget) {
      observer = new Observer(() => check());
      observer.observe(observationTarget, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }

    pollTimer = setInterval(check, pollMs);
    timeoutTimer = setTimeout(() => {
      finish({
        after: snapshotPage(document, options.urlProvider),
        satisfied: false,
        timedOut: true,
      });
    }, timeoutMs);
  });
}

function outcomeFailure(
  before: ExecutionSnapshot,
  outcome: WaitOutcome,
  expected: ExpectedOutcome,
  matchedTarget: string,
  warnings: string[],
): ExecutionResult {
  const code: ExecutionFailureCode =
    outcome.timedOut && hasExplicitOutcomePredicate(expected)
      ? "execution_timeout"
      : "no_observable_change";
  return failureResult(
    before,
    outcome.after,
    {
      code,
      message:
        code === "execution_timeout"
          ? "The requested observable outcome did not occur before the bounded execution timeout."
          : "The UI action completed without an observable URL, text, DOM, or control-state change.",
      details: {
        expectedEvent: expected.event ?? "",
        expectedUrlPattern: expected.urlPattern ?? "",
      },
    },
    matchedTarget,
    warnings,
  );
}

function executeDocumentUnavailable(): ExecutionResult {
  const snapshot = emptySnapshot();
  return failureResult(snapshot, snapshot, {
    code: "target_not_found",
    message: "No live document was supplied for visible UI execution.",
  });
}

async function executeControl(
  executor: Extract<ExecutorDefinition, { kind: "control" }>,
  args: unknown,
  document: Document,
  before: ExecutionSnapshot,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const objectError = argsObjectError(args);
  if (objectError)
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      objectError,
    );
  const record = args as Record<string, unknown>;
  if (!hasOwn(record, executor.valueField)) {
    return failureResult(before, snapshotPage(document, options.urlProvider), {
      code: "invalid_arguments",
      message: `Missing required argument ${executor.valueField}.`,
    });
  }

  const target = resolveTarget(document, executor.target);
  if ("error" in target) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      target.error,
    );
  }
  const targetError = checkVisibleAndEnabled(target.element);
  if (targetError) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      targetError,
      target.description,
    );
  }

  const operationError = applyControlValue(
    target.element,
    executor.control,
    record[executor.valueField],
    true,
  );
  if (operationError) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      operationError,
      target.description,
    );
  }

  const outcome = await waitForOutcome(
    document,
    before,
    expectedOrEmpty(executor.expected),
    options,
  );
  if (!outcome.satisfied) {
    return outcomeFailure(
      before,
      outcome,
      expectedOrEmpty(executor.expected),
      target.description,
      [],
    );
  }
  return completedResult(
    before,
    outcome.after,
    controlResultValue(target.element),
    target.description,
  );
}

function formControlKind(
  element: Element,
): "input" | "textarea" | "select" | "checkbox" | "radio" | null {
  return controlKind(element);
}

function controlResultValue(element: Element): JsonValue {
  const kind = controlKind(element);
  if (kind === "checkbox" || kind === "radio") {
    return { checked: readChecked(element) };
  }
  if (kind === "select") {
    return {
      value: readControlValue(element),
      selectedValues: readSelectedValues(element),
    };
  }
  return { value: readControlValue(element) };
}

async function executeForm(
  executor: Extract<ExecutorDefinition, { kind: "form" }>,
  args: unknown,
  document: Document,
  before: ExecutionSnapshot,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const objectError = argsObjectError(args);
  if (objectError)
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      objectError,
    );
  const record = args as Record<string, unknown>;

  const formTarget = resolveTarget(document, executor.form);
  if ("error" in formTarget) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      formTarget.error,
    );
  }
  if (formTarget.element.localName.toLowerCase() !== "form") {
    return failureResult(before, snapshotPage(document, options.urlProvider), {
      code: "unsupported_control",
      message: "The form executor locator did not resolve a form element.",
    });
  }
  const formVisibilityError = checkVisibleAndEnabled(formTarget.element);
  if (formVisibilityError) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      formVisibilityError,
      formTarget.description,
    );
  }

  for (const [fieldName, fieldLocator] of Object.entries(executor.fields)) {
    if (!hasOwn(record, fieldName)) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        {
          code: "invalid_arguments",
          message: `Missing required form argument ${fieldName}.`,
        },
        formTarget.description,
      );
    }
    const fieldTarget = resolveTarget(document, fieldLocator);
    if ("error" in fieldTarget) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        fieldTarget.error,
        formTarget.description,
      );
    }
    const fieldVisibilityError = checkVisibleAndEnabled(fieldTarget.element);
    if (fieldVisibilityError) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        fieldVisibilityError,
        fieldTarget.description,
      );
    }

    const kind = formControlKind(fieldTarget.element);
    if (!kind) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        {
          code: "unsupported_control",
          message: `Form field ${fieldName} is not a supported visible form control.`,
        },
        fieldTarget.description,
      );
    }
    const operationError = applyControlValue(
      fieldTarget.element,
      kind,
      record[fieldName],
      false,
    );
    if (operationError) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        operationError,
        fieldTarget.description,
      );
    }
  }

  const validity = callNativeMethod(formTarget.element, "checkValidity");
  if (validity.ok && validity.value === false) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      {
        code: "validation_failed",
        message: "The form is invalid and requestSubmit was not attempted.",
      },
      formTarget.description,
    );
  }

  let submitter: Element | undefined;
  if (executor.submit) {
    const submitTarget = resolveTarget(document, executor.submit);
    if ("error" in submitTarget) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        submitTarget.error,
      );
    }
    const submitterError = checkVisibleAndEnabled(submitTarget.element);
    if (submitterError) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        submitterError,
        submitTarget.description,
      );
    }
    if (!isClickableElement(submitTarget.element)) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        {
          code: "unsupported_control",
          message:
            "The form submit locator did not resolve a clickable submitter.",
        },
        submitTarget.description,
      );
    }
    submitter = submitTarget.element;
  }

  const requestSubmit = submitter
    ? callNativeMethod(formTarget.element, "requestSubmit", submitter)
    : callNativeMethod(formTarget.element, "requestSubmit");
  const warnings: string[] = [];
  if (!requestSubmit.ok) {
    const unavailable =
      requestSubmit.error instanceof Error &&
      requestSubmit.error.message === "requestSubmit is unavailable";
    if (!unavailable) {
      return failureResult(
        before,
        snapshotPage(document, options.urlProvider),
        {
          code: "validation_failed",
          message:
            requestSubmit.error instanceof Error
              ? requestSubmit.error.message
              : "The browser rejected requestSubmit.",
        },
        formTarget.description,
      );
    }
    // Very small DOM shims may not implement requestSubmit. Dispatching the
    // normal cancelable submit event preserves handler semantics; it never
    // calls the legacy form.submit() bypass.
    dispatchDomEvent(formTarget.element, "submit");
    warnings.push(
      "requestSubmit was unavailable; a normal submit event was dispatched.",
    );
  }

  const expected = expectedOrEmpty(executor.expected);
  const outcome = await waitForOutcome(document, before, expected, options);
  if (!outcome.satisfied) {
    return outcomeFailure(
      before,
      outcome,
      expected,
      formTarget.description,
      warnings,
    );
  }
  return completedResult(
    before,
    outcome.after,
    {
      submitted: true,
      fields: Object.keys(executor.fields),
    },
    formTarget.description,
    warnings,
  );
}

async function executeAction(
  executor: Extract<ExecutorDefinition, { kind: "action" }>,
  document: Document,
  before: ExecutionSnapshot,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const target = resolveTarget(document, executor.target);
  if ("error" in target) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      target.error,
    );
  }
  const targetError = checkVisibleAndEnabled(target.element);
  if (targetError) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      targetError,
      target.description,
    );
  }
  if (!isClickableElement(target.element)) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      {
        code: "unsupported_control",
        message:
          "The action locator did not resolve a normal visible link or button.",
      },
      target.description,
    );
  }
  if (
    executor.action === "navigate" &&
    target.element.localName.toLowerCase() === "a" &&
    target.element.getAttribute("href") === null
  ) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      {
        code: "unsupported_control",
        message: "A navigate action requires a link with an href.",
      },
      target.description,
    );
  }

  const click = callNativeMethod(target.element, "click");
  if (!click.ok) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      {
        code: "unsupported_control",
        message: "The target does not expose a native click method.",
      },
      target.description,
    );
  }

  const expected = expectedOrEmpty(executor.expected);
  const outcome = await waitForOutcome(document, before, expected, options);
  if (!outcome.satisfied) {
    return outcomeFailure(before, outcome, expected, target.description, []);
  }
  return completedResult(
    before,
    outcome.after,
    { clicked: true, action: executor.action },
    target.description,
  );
}

function readTargetResult(document: Document, element: Element): JsonValue {
  const value: Record<string, JsonValue> = {
    tagName: element.localName.toLowerCase(),
    role: getSemanticRole(element) ?? null,
    accessibleName: getAccessibleName(document, element) || null,
    text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
  };
  const kind = controlKind(element);
  if (kind === "input" || kind === "textarea" || kind === "select") {
    value.value = readControlValue(element);
  }
  if (kind === "checkbox" || kind === "radio")
    value.checked = readChecked(element);
  if (kind === "select") value.selectedValues = readSelectedValues(element);
  const href = element.getAttribute("href");
  if (href !== null) value.href = href;
  return value;
}

async function executeRead(
  executor: Extract<ExecutorDefinition, { kind: "read" }>,
  document: Document,
  before: ExecutionSnapshot,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const target = resolveTarget(document, executor.target);
  if ("error" in target) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      target.error,
    );
  }
  if (!isVisibleElement(target.element)) {
    return failureResult(
      before,
      snapshotPage(document, options.urlProvider),
      {
        code: "unsupported_control",
        message:
          "The read target is hidden and is not exposed through visible UI.",
      },
      target.description,
    );
  }
  const after = snapshotPage(document, options.urlProvider);
  return completedResult(
    before,
    after,
    readTargetResult(document, target.element),
    target.description,
  );
}

function validateSchemaValue(
  value: unknown,
  schema: JSONSchema,
  path: string,
): string | null {
  if (schema.enum && !schema.enum.some((item) => item === value)) {
    return `${path} must be one of the declared enum values.`;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) => {
      switch (type) {
        case "null":
          return value === null;
        case "string":
          return typeof value === "string";
        case "number":
          return typeof value === "number" && Number.isFinite(value);
        case "integer":
          return typeof value === "number" && Number.isInteger(value);
        case "boolean":
          return typeof value === "boolean";
        case "array":
          return Array.isArray(value);
        case "object":
          return isRecord(value);
        default:
          return false;
      }
    });
    if (!matches) return `${path} has the wrong JSON Schema type.`;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} is shorter than minLength.`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} is longer than maxLength.`;
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value))
          return `${path} does not match pattern.`;
      } catch {
        return `${path} uses an invalid pattern.`;
      }
    }
    if (
      schema.format === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      return `${path} must be a valid email address.`;
    }
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${path} must be an ISO date.`;
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} is below minimum.`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path} is above maximum.`;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      const error = validateSchemaValue(
        item,
        schema.items,
        `${path}[${index}]`,
      );
      if (error) return error;
    }
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return `${path}.${required} is required.`;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const error = validateSchemaValue(
          item,
          propertySchema,
          `${path}.${key}`,
        );
        if (error) return error;
        continue;
      }
      if (schema.additionalProperties === false) {
        return `${path}.${key} is not an allowed property.`;
      }
      if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        const error = validateSchemaValue(
          item,
          schema.additionalProperties,
          `${path}.${key}`,
        );
        if (error) return error;
      }
    }
  }
  return null;
}

export function validateExecutionArguments(
  args: unknown,
  schema: JSONSchema,
): string | null {
  return validateSchemaValue(args, schema, "$input");
}

/** Execute a fixed ExecutorDefinition against the caller's existing live DOM. */
export async function executeExecutor(
  executor: ExecutorDefinition,
  args: unknown,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const document = getDocument(options);
  if (!document) return executeDocumentUnavailable();
  const before = captureSnapshot(document, options);

  try {
    switch (executor.kind) {
      case "control":
        return await executeControl(executor, args, document, before, options);
      case "form":
        return await executeForm(executor, args, document, before, options);
      case "action":
        return await executeAction(executor, document, before, options);
      case "read":
        return await executeRead(executor, document, before, options);
      default:
        return failureResult(before, captureSnapshot(document, options), {
          code: "unsupported_control",
          message: "The executor definition kind is unsupported.",
        });
    }
  } catch (error) {
    return failureResult(
      before,
      captureSnapshot(document, options),
      unexpectedOperationError(error),
    );
  }
}

/** Validate a capability schema, then run its graph-defined executor. */
export async function executeCapability(
  capability: Capability,
  args: unknown,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const document = getDocument(options);
  if (!document) return executeDocumentUnavailable();
  const before = captureSnapshot(document, options);
  const validationError = validateExecutionArguments(
    args,
    capability.inputSchema,
  );
  if (validationError) {
    return failureResult(before, captureSnapshot(document, options), {
      code: "invalid_arguments",
      message: validationError,
    });
  }
  return executeExecutor(capability.executor, args, options);
}

export const execute = executeCapability;
