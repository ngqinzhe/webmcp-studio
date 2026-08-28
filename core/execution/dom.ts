type NativeMethod = (...args: unknown[]) => unknown;

function prototypeChain(value: object): object[] {
  const chain: object[] = [];
  // Start at the prototype. Page code can shadow DOM methods/getters on the
  // element instance; execution must still call the browser primitive.
  let current: object | null = Object.getPrototypeOf(value) as object | null;
  while (current) {
    chain.push(current);
    current = Object.getPrototypeOf(current) as object | null;
  }
  return chain;
}

/** Read a DOM API getter from its prototype, avoiding page-owned property shadowing. */
export function readNativeProperty(element: object, property: string): unknown {
  for (const prototype of prototypeChain(element)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.get) {
      try {
        return descriptor.get.call(element);
      } catch {
        continue;
      }
    }
    if (descriptor && "value" in descriptor) return descriptor.value;
  }
  return undefined;
}

/** Set a DOM API property through the native prototype setter where available. */
export function setNativeProperty(
  element: object,
  property: string,
  value: unknown,
): boolean {
  for (const prototype of prototypeChain(element)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set) {
      try {
        descriptor.set.call(element, value);
        return true;
      } catch {
        return false;
      }
    }
  }

  // Custom DOM implementations used by consumers may expose a writable data
  // property rather than a native setter. This is still a normal DOM write,
  // not page-code evaluation.
  try {
    return Reflect.set(element, property, value);
  } catch {
    return false;
  }
}

/** Invoke a native DOM method without trusting an own property supplied by the page. */
export function callNativeMethod(
  element: object,
  methodName: string,
  ...args: unknown[]
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  for (const prototype of prototypeChain(element)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor || !("value" in descriptor)) continue;
    if (typeof descriptor.value !== "function") {
      return { ok: false, error: new Error(`${methodName} is not callable`) };
    }
    try {
      return {
        ok: true,
        value: (descriptor.value as NativeMethod).apply(element, args),
      };
    } catch (error) {
      return { ok: false, error };
    }
  }
  return { ok: false, error: new Error(`${methodName} is unavailable`) };
}

export function dispatchDomEvent(
  element: Element,
  type: "input" | "change" | "submit" | "click",
): boolean {
  const document = element.ownerDocument;
  try {
    const EventConstructor = document?.defaultView?.Event;
    if (EventConstructor) {
      element.dispatchEvent(
        new EventConstructor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return true;
    }

    if (document) {
      const event = document.createEvent("Event");
      event.initEvent(type, true, true);
      element.dispatchEvent(event);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function semanticParent(node: Node): Node | null {
  if (node.parentNode) return node.parentNode;
  if (node.nodeType === 11) return (node as ShadowRoot).host ?? null;
  return null;
}

function styleHides(element: Element): boolean {
  const inlineStyle = element.getAttribute("style") ?? "";
  const declarations = inlineStyle
    .toLocaleLowerCase()
    .split(";")
    .map((declaration) => declaration.trim());
  for (const declaration of declarations) {
    const [property, rawValue] = declaration.split(":", 2);
    const value = rawValue?.trim();
    if (
      (property?.trim() === "display" && value === "none") ||
      (property?.trim() === "visibility" &&
        (value === "hidden" || value === "collapse")) ||
      (property?.trim() === "content-visibility" && value === "hidden")
    ) {
      return true;
    }
  }

  try {
    const computedStyle =
      element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (
      computedStyle &&
      (computedStyle.display === "none" ||
        computedStyle.visibility === "hidden" ||
        computedStyle.visibility === "collapse")
    ) {
      return true;
    }
  } catch {
    // Some DOM shims do not implement computed style.
  }
  return false;
}

export function isVisibleElement(element: Element): boolean {
  const connected = readNativeProperty(element, "isConnected");
  if (connected === false) return false;
  if (
    element.localName.toLowerCase() === "input" &&
    (element.getAttribute("type") ?? "text").toLowerCase() === "hidden"
  ) {
    return false;
  }

  let current: Node | null = element;
  while (current) {
    if (current.nodeType === 1) {
      const candidate = current as Element;
      if (
        candidate.hasAttribute("hidden") ||
        candidate.getAttribute("aria-hidden")?.toLocaleLowerCase() === "true" ||
        styleHides(candidate)
      ) {
        return false;
      }
    }
    current = semanticParent(current);
  }
  return true;
}

export function isDisabledElement(element: Element): boolean {
  if (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled")?.toLocaleLowerCase() === "true"
  ) {
    return true;
  }

  let current = semanticParent(element);
  while (current) {
    if (
      current.nodeType === 1 &&
      (current as Element).localName.toLowerCase() === "fieldset" &&
      (current as Element).hasAttribute("disabled")
    ) {
      return true;
    }
    current = semanticParent(current);
  }
  return false;
}

export function readDocumentUrl(document: Document): string {
  try {
    const href = document.defaultView?.location?.href;
    if (href) return href;
  } catch {
    // Cross-origin or test DOM location access can throw.
  }
  try {
    return document.URL ?? "";
  } catch {
    return "";
  }
}

export function readControlValue(element: Element): string {
  const value = readNativeProperty(element, "value");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return element.getAttribute("value") ?? "";
}

export function readChecked(element: Element): boolean {
  return readNativeProperty(element, "checked") === true;
}

export function readSelectedValues(element: Element): string[] {
  return Array.from(element.querySelectorAll("option"))
    .filter((option) => readNativeProperty(option, "selected") === true)
    .map((option) => readControlValue(option));
}

export function controlKind(
  element: Element,
): "input" | "textarea" | "select" | "checkbox" | "radio" | null {
  const tagName = element.localName.toLowerCase();
  if (tagName === "textarea") return "textarea";
  if (tagName === "select") return "select";
  if (tagName !== "input") return null;

  const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
  if (inputType === "checkbox") return "checkbox";
  if (inputType === "radio") return "radio";
  if (inputType === "hidden") return null;
  return "input";
}
