import type { JSONSchema, JsonPrimitive } from "../types";
import type { DiscoveredElement, DiscoveredForm } from "../dom/types";
import { getAccessibleName, isRequired } from "../dom/accessibility";
import {
  controlType,
  hasAttribute,
  readAttribute,
  readRawAttribute,
  readableText,
  slugify,
} from "../dom/utils";

export interface SchemaField {
  key: string;
  element: Element;
  schema: JSONSchema;
  required: boolean;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function safePattern(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    // Validation only: the pattern is retained as JSON Schema data and is
    // never executed against page content by this module.
    // eslint-disable-next-line no-new
    new RegExp(value);
    return value;
  } catch {
    return undefined;
  }
}

function optionValue(option: Element): string {
  const value = readRawAttribute(option, "value");
  return value !== null ? value : readableText(option, 120);
}

function selectEnum(element: Element): string[] {
  const values: string[] = [];
  for (const option of Array.from(element.querySelectorAll("option"))) {
    if (hasAttribute(option, "disabled")) continue;
    const value = optionValue(option);
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function baseDescription(element: Element): string | undefined {
  const name = getAccessibleName(element);
  return name ? `Value for ${name}` : undefined;
}

function addTextConstraints(schema: JSONSchema, element: Element): void {
  const minLength = parseFiniteNumber(readAttribute(element, "minlength"));
  const maxLength = parseFiniteNumber(readAttribute(element, "maxlength"));
  const pattern = safePattern(readAttribute(element, "pattern"));
  if (minLength !== undefined && minLength >= 0)
    schema.minLength = Math.floor(minLength);
  if (maxLength !== undefined && maxLength >= 0)
    schema.maxLength = Math.floor(maxLength);
  if (pattern) schema.pattern = pattern;
}

function addNumericConstraints(schema: JSONSchema, element: Element): void {
  const minimum = parseFiniteNumber(readAttribute(element, "min"));
  const maximum = parseFiniteNumber(readAttribute(element, "max"));
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
}

function radioValue(element: Element): string {
  return readAttribute(element, "value") ?? "on";
}

export function inferRadioGroupSchema(
  elements: readonly Element[],
): JSONSchema {
  const values = Array.from(new Set(elements.map(radioValue).filter(Boolean)));
  const schema: JSONSchema = { type: "string" };
  if (values.length > 0) schema.enum = values;
  const description = elements
    .map((element) => getAccessibleName(element))
    .find(Boolean);
  if (description) schema.description = `Choose ${description}`;
  return schema;
}

/** Infer the value schema for one native control. */
export function inferControlSchema(element: Element): JSONSchema {
  const tag = element.localName.toLowerCase();
  const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
  const description = baseDescription(element);
  let schema: JSONSchema;

  if (tag === "select") {
    const values = selectEnum(element);
    if (hasAttribute(element, "multiple")) {
      schema = { type: "array", items: { type: "string" } };
      if (values.length > 0) schema.items = { type: "string", enum: values };
    } else {
      schema = { type: "string" };
      if (values.length > 0) schema.enum = values;
    }
  } else if (tag === "textarea") {
    schema = { type: "string" };
    addTextConstraints(schema, element);
  } else if (type === "checkbox") {
    schema = { type: "boolean" };
  } else if (type === "radio") {
    schema = { type: "string", enum: [radioValue(element)] };
  } else if (["number", "range"].includes(type)) {
    schema = { type: "number" };
    addNumericConstraints(schema, element);
  } else {
    schema = { type: "string" };
    if (type === "email" || readAttribute(element, "autocomplete") === "email")
      schema.format = "email";
    else if (type === "date") schema.format = "date";
    else if (type === "datetime-local") schema.format = "date-time";
    else if (type === "time") schema.format = "time";
    else if (type === "url") schema.format = "uri";
    addTextConstraints(schema, element);
  }

  if (description) schema.description = description;
  return schema;
}

export const inferControl = inferControlSchema;

export function fieldNameForElement(
  element: Element,
  fallback = "value",
): string {
  const explicit =
    readAttribute(element, "name") ?? readAttribute(element, "id");
  if (explicit) return slugify(explicit, fallback);
  const label = getAccessibleName(element);
  if (label) return slugify(label, fallback);
  const placeholder = readAttribute(element, "placeholder");
  return placeholder ? slugify(placeholder, fallback) : fallback;
}

function asDiscoveredControl(value: Element | DiscoveredElement): Element {
  return "element" in value ? value.element : value;
}

function formControls(
  form: Element,
  supplied?: readonly DiscoveredElement[],
): Element[] {
  if (supplied)
    return supplied
      .filter((control) => control.controlType)
      .map((control) => control.element);
  return Array.from(form.querySelectorAll("input,textarea,select")).filter(
    (element) => Boolean(controlType(element)),
  );
}

export function inferSchemaFields(
  controls: readonly (Element | DiscoveredElement)[],
): SchemaField[] {
  const counts = new Map<string, number>();
  const fields: SchemaField[] = [];
  for (const value of controls) {
    const element = asDiscoveredControl(value);
    const control = controlType(element);
    if (!control) continue;

    const baseKey = fieldNameForElement(
      element,
      control === "input" ? "value" : control,
    );
    const count = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, count);
    const key = count === 1 ? baseKey : `${baseKey}_${count}`;
    fields.push({
      key,
      element,
      schema: inferControlSchema(element),
      required: isRequired(element),
    });
  }
  return fields;
}

function groupedRadioFields(fields: SchemaField[]): SchemaField[] {
  const result: SchemaField[] = [];
  const radioGroups = new Map<string, SchemaField[]>();
  for (const field of fields) {
    if (readAttribute(field.element, "type")?.toLowerCase() !== "radio") {
      result.push(field);
      continue;
    }
    const group = readAttribute(field.element, "name") ?? field.key;
    const entries = radioGroups.get(group) ?? [];
    entries.push(field);
    radioGroups.set(group, entries);
  }
  for (const entries of radioGroups.values()) {
    const first = entries[0];
    if (!first) continue;
    const schema = inferRadioGroupSchema(entries.map((entry) => entry.element));
    const groupName = readAttribute(first.element, "name") ?? first.key;
    result.push({
      key: slugify(groupName, first.key),
      element: first.element,
      schema,
      required: entries.some((entry) => entry.required),
    });
  }
  return result;
}

export function inferFormSchema(
  formOrElement: DiscoveredForm | Element,
  suppliedControls?: readonly DiscoveredElement[],
): JSONSchema {
  const form =
    "element" in formOrElement ? formOrElement.element : formOrElement;
  const controls =
    "element" in formOrElement ? formOrElement.controls : suppliedControls;
  const fields = groupedRadioFields(
    inferSchemaFields(formControls(form, controls)),
  );
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.key] = field.schema;
    if (field.required) required.push(field.key);
  }

  const schema: JSONSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = Array.from(new Set(required));
  const description = getAccessibleName(form);
  if (description) schema.description = description;
  return schema;
}

export const inferFormInputSchema = inferFormSchema;

export function inferSchema(
  value: Element | readonly Element[] | DiscoveredForm,
): JSONSchema {
  if (Array.isArray(value)) {
    const fields = groupedRadioFields(inferSchemaFields(value));
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const field of fields) {
      properties[field.key] = field.schema;
      if (field.required) required.push(field.key);
    }
    const schema: JSONSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) schema.required = required;
    return schema;
  }
  if ("controls" in value) return inferFormSchema(value as DiscoveredForm);
  const element = value as Element;
  if (element.localName.toLowerCase() === "form")
    return inferFormSchema(element);
  return inferControlSchema(element);
}

export function schemaPrimitiveDefault(
  element: Element,
): JsonPrimitive | undefined {
  const value = readAttribute(element, "value");
  if (value === undefined) return undefined;
  const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
  if (["number", "range"].includes(type))
    return parseFiniteNumber(value) ?? undefined;
  if (type === "checkbox") return hasAttribute(element, "checked");
  return value;
}
