import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  inferControlSchema,
  inferFormSchema,
  inferRadioGroupSchema,
  inferSchema,
} from "../../core/schema/infer";

describe("DOM to JSON Schema inference", () => {
  it("maps common input types and constraints", () => {
    const dom = new JSDOM(`
      <form>
        <input id="email" type="email" required minlength="5" maxlength="80">
        <input id="age" type="number" min="18" max="120">
        <input id="birthday" type="date">
        <input id="enabled" type="checkbox">
      </form>
    `);
    const document = dom.window.document;
    const email = inferControlSchema(document.querySelector("#email")!);
    const age = inferControlSchema(document.querySelector("#age")!);
    const date = inferControlSchema(document.querySelector("#birthday")!);
    const checkbox = inferControlSchema(document.querySelector("#enabled")!);

    expect(email).toMatchObject({
      type: "string",
      format: "email",
      minLength: 5,
      maxLength: 80,
    });
    expect(age).toMatchObject({ type: "number", minimum: 18, maximum: 120 });
    expect(date).toMatchObject({ type: "string", format: "date" });
    expect(checkbox.type).toBe("boolean");
  });

  it("infers select enums, multi-select arrays, and radio-group enums", () => {
    const dom = new JSDOM(`
      <select id="sort"><option value="">All</option><option value="relevance">Relevance</option><option value="price">Price</option></select>
      <select id="tags" multiple><option value="keyboard">Keyboard</option><option value="mouse">Mouse</option></select>
      <fieldset>
        <input type="radio" name="delivery" value="standard" aria-label="Standard">
        <input type="radio" name="delivery" value="express" aria-label="Express">
      </fieldset>
    `);
    const document = dom.window.document;
    expect(inferControlSchema(document.querySelector("#sort")!)).toMatchObject({
      type: "string",
      enum: ["", "relevance", "price"],
    });
    expect(inferControlSchema(document.querySelector("#tags")!)).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["keyboard", "mouse"] },
    });
    expect(
      inferRadioGroupSchema(
        Array.from(document.querySelectorAll("input[type=radio]")),
      ),
    ).toMatchObject({
      type: "string",
      enum: ["standard", "express"],
    });
  });

  it("builds object schemas with field descriptions and required fields", () => {
    const dom = new JSDOM(`
      <form aria-label="Contact form">
        <label for="email">Email address</label><input id="email" name="email" type="email" required>
        <label for="message">Message</label><textarea id="message" name="message"></textarea>
      </form>
    `);
    const schema = inferFormSchema(dom.window.document.querySelector("form")!);
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["email"],
    });
    expect(schema.properties?.email).toMatchObject({
      type: "string",
      format: "email",
    });
    expect(schema.properties?.message?.description).toBe("Value for Message");
    expect(schema.description).toBe("Contact form");
  });

  it("drops invalid patterns instead of treating them as executable code", () => {
    const dom = new JSDOM(`<input id="unsafe" pattern="[">`);
    const schema = inferControlSchema(
      dom.window.document.querySelector("#unsafe")!,
    );
    expect(schema.pattern).toBeUndefined();
  });

  it("supports the generic inferSchema entry point", () => {
    const dom = new JSDOM(
      `<form><input name="query" type="search"><input name="page" type="number"></form>`,
    );
    const controls = Array.from(
      dom.window.document.querySelectorAll("input"),
    ) as Element[];
    const schema = inferSchema(controls);
    expect(schema.properties?.query?.type).toBe("string");
    expect(schema.properties?.page?.type).toBe("number");
    expect(inferSchema(dom.window.document.querySelector("form")!).type).toBe(
      "object",
    );
  });
});
