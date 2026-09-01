const MAX_HTML_BYTES = 1_250_000;
const MAX_PREVIEW_HTML_BYTES = 200_000;
const MAX_TOOLS = 24;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BODY_BYTES = 16_384;
const REQUEST_BODY_TIMEOUT_MS = 5_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PREVIEW_ALLOWED_TAGS = new Set([
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "html",
  "hr",
  "input",
  "label",
  "legend",
  "li",
  "main",
  "ol",
  "option",
  "optgroup",
  "p",
  "pre",
  "q",
  "s",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "summary",
  "table",
  "textarea",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "u",
  "ul",
  "var",
]);
const PREVIEW_VOID_TAGS = new Set(["br", "col", "hr", "input"]);
const PREVIEW_BLOCKED_CONTENT_TAGS = new Set([
  "applet",
  "frame",
  "frameset",
  "iframe",
  "math",
  "object",
  "portal",
  "script",
  "style",
  "svg",
  "template",
]);
const PREVIEW_BLOCKED_TAGS = new Set([
  "audio",
  "base",
  "canvas",
  "embed",
  "link",
  "meta",
  "param",
  "picture",
  "source",
  "track",
  "video",
]);
const PREVIEW_URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "srcdoc",
  "srcset",
  "usemap",
  "xlink:href",
]);
const PREVIEW_SAFE_ATTRIBUTES = new Set([
  "alt",
  "checked",
  "class",
  "colspan",
  "dir",
  "disabled",
  "for",
  "hidden",
  "id",
  "lang",
  "max",
  "maxlength",
  "min",
  "multiple",
  "name",
  "open",
  "placeholder",
  "readonly",
  "required",
  "role",
  "rowspan",
  "rows",
  "selected",
  "size",
  "span",
  "step",
  "tabindex",
  "title",
  "type",
  "value",
  "wrap",
]);
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data.ec2.internal",
  "localtest.me",
  "lvh.me",
  "nip.io",
  "sslip.io",
  "xip.io",
]);

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : "";
}

function publicIpv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const octets = host.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function mappedIpv4(host) {
  if (!host.startsWith("::ffff:")) return null;
  const suffix = host.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part)))
    return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function publicHostname(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    Array.from(BLOCKED_HOSTNAMES).some((blocked) =>
      host.endsWith(`.${blocked}`),
    ) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid")
  )
    return false;

  const ipv4 = publicIpv4(host);
  if (ipv4 !== null) return ipv4;

  if (host.includes(":")) {
    const mapped = mappedIpv4(host);
    if (mapped) return publicIpv4(mapped) === true;
    return !(
      host === "::" ||
      host === "::1" ||
      host.startsWith("ff") ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fec0:")
    );
  }
  return host.length > 0;
}

export function validateExternalUrl(rawUrl, options = {}) {
  const requireHttps = options.requireHttps === true;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid external http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only external http and https sites can be inspected.");
  if (requireHttps && url.protocol !== "https:")
    throw new Error("Secure hosted Studio inspection requires an https URL.");
  if (url.username || url.password)
    throw new Error("External URLs cannot contain embedded credentials.");
  if (
    (url.protocol === "http:" && url.port && url.port !== "80") ||
    (url.protocol === "https:" && url.port && url.port !== "443")
  )
    throw new Error(
      "External inspection only supports the standard web ports.",
    );
  if (!publicHostname(url.hostname))
    throw new Error(
      "That hostname is private or reserved and cannot be inspected.",
    );
  url.hash = "";
  return url;
}

function responseHeader(response, name) {
  const headers = response?.headers?.get ? response.headers : response;
  return textValue(headers?.get?.(name)).trim();
}

function isHtmlContentType(contentType) {
  const mediaType = textValue(contentType)
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return HTML_CONTENT_TYPES.includes(mediaType);
}

function framePolicy(targetUrl, headers, studioOrigin) {
  const targetOrigin = new URL(targetUrl).origin;
  const xFrameOptions = responseHeader(
    headers,
    "x-frame-options",
  ).toLowerCase();
  if (xFrameOptions.includes("deny"))
    return {
      status: "blocked",
      reason: "The site sends X-Frame-Options: DENY.",
    };
  if (xFrameOptions.includes("sameorigin") && targetOrigin !== studioOrigin)
    return {
      status: "blocked",
      reason: "The site only allows framing by its own origin.",
    };

  const contentSecurityPolicy = responseHeader(
    headers,
    "content-security-policy",
  );
  const frameAncestors = contentSecurityPolicy.match(
    /(?:^|;)\s*frame-ancestors\s+([^;]+)/i,
  );
  if (frameAncestors) {
    const sources = frameAncestors[1]
      .split(/\s+/)
      .map((source) => source.trim().toLowerCase())
      .filter(Boolean);
    const allowsStudio = sources.some((source) => {
      if (source === "*") return true;
      if (source === "'none'") return false;
      if (source === "'self'") return targetOrigin === studioOrigin;
      if (source === "https:") return studioOrigin.startsWith("https:");
      return source === studioOrigin.toLowerCase();
    });
    if (!allowsStudio)
      return {
        status: "blocked",
        reason:
          "The site Content-Security-Policy disallows this embedded preview.",
      };
  }

  return {
    status: "allowed",
    reason: "No framing restriction was found in the inspected response.",
  };
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([\da-f]+);/gi, (_, code) => {
      const parsed = Number.parseInt(code, 16);
      return parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : "";
    })
    .replace(/&#(\d+);/g, (_, code) => {
      const parsed = Number(code);
      return parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : "";
    });
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function findPreviewTagEnd(source, start) {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function escapePreviewAttribute(value) {
  return decodeEntities(value)
    .replace(/\u0000/g, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafePreviewAttribute(name) {
  if (name.startsWith("on") || PREVIEW_URL_ATTRIBUTES.has(name)) return false;
  if (PREVIEW_SAFE_ATTRIBUTES.has(name)) return true;
  return /^aria-[a-z][a-z0-9_-]*$/.test(name);
}

function sanitizePreviewAttributes(source) {
  const attributes = [];
  const attributePattern =
    /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attributePattern.exec(source)) !== null) {
    const name = match[1]?.toLowerCase() ?? "";
    if (!name || !isSafePreviewAttribute(name)) continue;
    const value = match[2] ?? match[3] ?? match[4];
    attributes.push(
      value === undefined
        ? ` ${name}`
        : ` ${name}="${escapePreviewAttribute(value)}"`,
    );
  }
  return attributes.join("");
}

function sanitizePreviewHtml(html) {
  const source = textValue(html);
  if (!source) return "";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;

  const append = (value, allowPartial) => {
    if (truncated || !value) return !truncated;
    const encoded = encoder.encode(value);
    const remaining = MAX_PREVIEW_HTML_BYTES - totalBytes;
    if (encoded.byteLength <= remaining) {
      chunks.push(value);
      totalBytes += encoded.byteLength;
      return true;
    }
    if (allowPartial && remaining > 0) {
      const partial = decoder.decode(encoded.slice(0, remaining));
      if (partial) {
        chunks.push(partial);
        totalBytes += encoder.encode(partial).byteLength;
      }
    }
    truncated = true;
    return false;
  };

  let index = 0;
  while (index < source.length && !truncated) {
    const tagStart = source.indexOf("<", index);
    if (tagStart === -1) {
      append(source.slice(index), true);
      break;
    }
    if (tagStart > index && !append(source.slice(index, tagStart), true)) break;

    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      index = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findPreviewTagEnd(source, tagStart + 1);
    if (tagEnd === -1) break;
    const rawTag = source.slice(tagStart, tagEnd + 1);
    const tagMatch = rawTag.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
    if (!tagMatch) {
      index = tagEnd + 1;
      continue;
    }

    const closing = tagMatch[1] === "/";
    const tagName = tagMatch[2].toLowerCase();
    if (PREVIEW_BLOCKED_CONTENT_TAGS.has(tagName) && !closing) {
      const closingPattern = new RegExp(`</\\s*${tagName}\\s*>`, "ig");
      closingPattern.lastIndex = tagEnd + 1;
      const closingMatch = closingPattern.exec(source);
      index = closingMatch
        ? closingMatch.index + closingMatch[0].length
        : source.length;
      continue;
    }
    if (
      PREVIEW_BLOCKED_CONTENT_TAGS.has(tagName) ||
      PREVIEW_BLOCKED_TAGS.has(tagName)
    ) {
      index = tagEnd + 1;
      continue;
    }
    if (!PREVIEW_ALLOWED_TAGS.has(tagName)) {
      index = tagEnd + 1;
      continue;
    }

    if (closing) {
      if (PREVIEW_VOID_TAGS.has(tagName)) {
        index = tagEnd + 1;
        continue;
      }
      if (!append(`</${tagName}>`, false)) break;
    } else {
      const attributeSource = rawTag
        .slice(tagMatch[0].length, -1)
        .replace(/\/\s*$/, "");
      const normalizedTag = `<${tagName}${sanitizePreviewAttributes(
        attributeSource,
      )}>`;
      if (!append(normalizedTag, false)) break;
    }
    index = tagEnd + 1;
  }

  return chunks.join("");
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function hasAttribute(tag, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(tag);
}

function selectorFor(tag, index, fallback = "control") {
  const id = attribute(tag, "id");
  if (id) return `#${id}`;
  const name = attribute(tag, "name");
  if (name) return `[name="${name}"]`;
  return `${fallback}:nth-of-type(${index + 1})`;
}

function schemaProperty(type, description) {
  return {
    type,
    ...(description ? { description } : {}),
  };
}

function uniqueName(name, used) {
  if (!TOOL_NAME_PATTERN.test(name) || used.has(name)) return null;
  used.add(name);
  return name;
}

function extractSchemaFromSource(source) {
  const properties = {};
  const propertiesBlock =
    source.match(/\bproperties\s*:\s*\{([\s\S]{0,1800})/i)?.[1] ?? "";
  const propertyPattern = /([a-zA-Z_$][\w$-]*)\s*:\s*\{([\s\S]{0,240}?)\}/g;
  let match;
  while ((match = propertyPattern.exec(propertiesBlock)) !== null) {
    const [, name, definition] = match;
    const type = definition
      .match(
        /\btype\s*:\s*["'](string|number|integer|boolean|array|object)["']/i,
      )?.[1]
      ?.toLowerCase();
    if (name && type)
      properties[name] = schemaProperty(
        type,
        `Parameter from the page's WebMCP declaration.`,
      );
  }
  const required = Array.from(
    (source.match(/\brequired\s*:\s*\[([^\]]*)\]/i)?.[1] ?? "").matchAll(
      /["']([a-zA-Z_$][\w$-]*)["']/g,
    ),
  ).map((entry) => entry[1]);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function nativeToolsFromHtml(html, used) {
  const tools = [];
  const registrationPattern =
    /\b(?:modelContext|navigator\.modelContext|document\.modelContext)\s*\.\s*(?:registerTool|provideTool)\s*\(\s*\{([\s\S]{0,3600}?)(?:\}\s*\)|\);)/gi;
  let match;
  while (
    (match = registrationPattern.exec(html)) !== null &&
    tools.length < MAX_TOOLS
  ) {
    const source = match[1] ?? "";
    const name = source
      .match(/\bname\s*:\s*["'`]([a-zA-Z][\w-]*)["'`]/)?.[1]
      ?.toLowerCase();
    if (!name) continue;
    const unique = uniqueName(name, used);
    if (!unique) continue;
    const description = decodeEntities(
      source.match(/\bdescription\s*:\s*["'`]([^"'`]{1,280})["'`]/)?.[1] ??
        "Declared by the page through its WebMCP model context.",
    );
    tools.push({
      name: unique,
      description,
      inputSchema: extractSchemaFromSource(source),
      annotations: { readOnlyHint: true },
      // A fetched script is only evidence of a potential declaration. The
      // browser's live modelContext cannot be observed across origins, so an
      // external result must never be presented as a verified Native tool.
      source: "manual",
      confidence: 0.86,
      evidence: [
        {
          type: "manual",
          selector: "script",
          note: "Fetched page source contains a potential modelContext WebMCP registration; verify it on the live origin.",
        },
      ],
    });
  }
  return tools;
}

function inferredToolsFromHtml(html, used) {
  const tools = [];
  const add = (tool) => {
    if (tools.length >= MAX_TOOLS) return;
    const name = uniqueName(tool.name, used);
    if (!name) return;
    tools.push({ ...tool, name });
  };

  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch;
  let formIndex = 0;
  while ((formMatch = formPattern.exec(html)) !== null) {
    const formTag = formMatch[1] ?? "";
    const body = formMatch[2] ?? "";
    const controls = Array.from(
      body.matchAll(/<(input|textarea|select)\b([^>]*)>/gi),
    );
    const searchControl = controls.find((entry) => {
      const tag = entry[2] ?? "";
      const type = attribute(tag, "type").toLowerCase();
      const hint =
        `${attribute(tag, "name")} ${attribute(tag, "placeholder")} ${attribute(tag, "aria-label")}`.toLowerCase();
      return type === "search" || /search|query|keyword/.test(hint);
    });
    if (searchControl) {
      const tag = searchControl[2] ?? "";
      const field = attribute(tag, "name") || "query";
      add({
        name: "search_content",
        description:
          "Potentially search the page using its visible search form.",
        inputSchema: {
          type: "object",
          properties: {
            [field]: schemaProperty(
              "string",
              "Value entered into the observed search field.",
            ),
          },
          required: [field],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        source: "dom",
        confidence: 0.76,
        evidence: [
          {
            type: "dom",
            selector: selectorFor(formTag, formIndex, "form"),
            note: `Observed a search-like ${attribute(tag, "type") || "text"} field named ${field}.`,
          },
        ],
      });
    } else if (controls.length > 0) {
      const properties = {};
      const required = [];
      for (const [, , tag] of controls) {
        const field = attribute(tag, "name");
        if (!field || !/^[a-zA-Z][\w-]{0,63}$/.test(field)) continue;
        const type = attribute(tag, "type").toLowerCase();
        const schemaType =
          type === "number"
            ? "number"
            : type === "checkbox"
              ? "boolean"
              : "string";
        properties[field] = schemaProperty(
          schemaType,
          "Value from an observed form control.",
        );
        if (hasAttribute(tag, "required")) required.push(field);
      }
      const namedFields = Object.keys(properties);
      if (namedFields.length > 0) {
        add({
          name: "submit_form",
          description:
            "Potentially submit the page form using its visible fields.",
          inputSchema: {
            type: "object",
            properties,
            ...(required.length > 0 ? { required } : {}),
            additionalProperties: false,
          },
          annotations: { destructiveHint: true },
          source: "dom",
          confidence: 0.61,
          evidence: [
            {
              type: "dom",
              selector: selectorFor(formTag, formIndex, "form"),
              note: `Observed ${namedFields.length} named form field${namedFields.length === 1 ? "" : "s"}.`,
            },
          ],
        });
      } else {
        add({
          name: "submit_form",
          description:
            "Potentially submit the observed page form; field names were not available in the returned markup.",
          inputSchema: {
            type: "object",
            properties: {
              fields: {
                type: "object",
                description:
                  "Optional values keyed by an observed control label or position.",
                additionalProperties: {
                  type: "string",
                },
              },
            },
            additionalProperties: false,
          },
          annotations: { destructiveHint: true },
          source: "dom",
          confidence: 0.48,
          evidence: [
            {
              type: "dom",
              selector: selectorFor(formTag, formIndex, "form"),
              note: `Observed ${controls.length} form control${controls.length === 1 ? "" : "s"}, but no valid named fields were available for a typed schema.`,
            },
          ],
        });
      }
    }
    formIndex += 1;
  }

  const controlPattern =
    /<(button|a|input)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\s*\/?>)/gi;
  let controlMatch;
  let controlIndex = 0;
  while ((controlMatch = controlPattern.exec(html)) !== null) {
    const tagName = controlMatch[1]?.toLowerCase() ?? "control";
    const tag = controlMatch[2] ?? "";
    const label = stripTags(
      controlMatch[3] ||
        attribute(tag, "value") ||
        attribute(tag, "aria-label"),
    );
    const normalized = label.toLowerCase();
    const selector = selectorFor(tag, controlIndex, tagName);
    if (/add\s+to\s+(cart|bag)|buy\s+now|purchase/.test(normalized)) {
      add({
        name: "add_to_cart",
        description: "Potentially add the visible item to a cart or bag.",
        inputSchema: {
          type: "object",
          properties: {
            quantity: { type: "integer", minimum: 1, default: 1 },
          },
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        source: "dom",
        confidence: 0.72,
        evidence: [
          {
            type: "dom",
            selector,
            note: `Observed action label: ${label.slice(0, 120)}.`,
          },
        ],
      });
    } else if (/\b(cart|bag|basket)\b/.test(normalized)) {
      add({
        name: "view_cart",
        description: "Potentially open the page's visible cart or bag.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        source: "dom",
        confidence: 0.68,
        evidence: [
          {
            type: "dom",
            selector,
            note: `Observed navigation label: ${label.slice(0, 120)}.`,
          },
        ],
      });
    } else if (/\b(book|reserve|select|choose)\b/.test(normalized)) {
      add({
        name: "select_option",
        description:
          "Potentially select the visible option for the page's flow.",
        inputSchema: {
          type: "object",
          properties: {
            optionId: {
              type: "string",
              description: "Visible option identifier.",
            },
          },
          required: ["optionId"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        source: "dom",
        confidence: 0.58,
        evidence: [
          {
            type: "dom",
            selector,
            note: `Observed action label: ${label.slice(0, 120)}.`,
          },
        ],
      });
    }
    controlIndex += 1;
  }
  return tools;
}

export function analyzeExternalHtml({
  url,
  html,
  status = 200,
  contentType = "text/html",
  headers = new Headers(),
  studioOrigin = "",
}) {
  const targetUrl = validateExternalUrl(url).href;
  const frame = framePolicy(
    targetUrl,
    headers,
    studioOrigin || new URL(targetUrl).origin,
  );
  const title = stripTags(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
  );
  const usableHtml = isHtmlContentType(contentType);
  if (!usableHtml)
    return {
      status: "blocked",
      url: targetUrl,
      title,
      tools: [],
      frame,
      previewHtml: "",
      note: `The site returned HTTP ${status} with ${contentType || "an unsupported content type"}; no tool proposals were created.`,
    };

  const previewHtml = sanitizePreviewHtml(html);
  const used = new Set();
  const native = nativeToolsFromHtml(html, used);
  const inferred = [
    ...inferredToolsFromHtml(html, used),
    // Some challenge pages contain permissive or slightly malformed HTML
    // (for example whitespace in a closing tag). The bounded sanitized
    // snapshot normalizes those tags while preserving the actionable form
    // evidence, so retry inference against it before reporting no tools.
    ...inferredToolsFromHtml(previewHtml, used),
  ];
  const tools = [...native, ...inferred];
  const responseContext =
    status >= 200 && status < 300
      ? ""
      : ` The returned page was HTTP ${status}; it was analyzed as evidence only.`;
  const notePrefix = responseContext ? `${responseContext} ` : "";
  return {
    status: tools.length > 0 ? "inspected" : "no_tools",
    url: targetUrl,
    title,
    tools,
    frame,
    previewHtml,
    note:
      tools.length > 0
        ? `${notePrefix}Inspected the returned page source: ${native.length} potential WebMCP declaration${native.length === 1 ? "" : "s"} and ${inferred.length} interface tool${inferred.length === 1 ? "" : "s"}. External results remain inferred until verified on the live page.`
        : `${notePrefix}The returned page did not expose a readable WebMCP declaration or supported actionable interface evidence.`,
  };
}

async function readLimitedText(response, signal) {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES)
    throw new Error("The external page is larger than the inspection limit.");
  if (!response.body || typeof response.body.getReader !== "function") {
    const value = signal
      ? await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            callback(value);
          };
          const abort = () =>
            finish(
              reject,
              new Error("The external page inspection timed out."),
            );
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          response.text().then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
          );
        })
      : await response.text();
    if (signal?.aborted)
      throw new Error("The external page inspection timed out.");
    if (new TextEncoder().encode(value).byteLength > MAX_HTML_BYTES)
      throw new Error("The external page is larger than the inspection limit.");
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancelReader = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted)
        throw new Error("The external page inspection timed out.");
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error(
          "The external page is larger than the inspection limit.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchWithRedirects(url, fetchImpl, options = {}) {
  let current = validateExternalUrl(url, options);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        credentials: "omit",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "user-agent": "WebMCP-Studio/1.0 capability inspector",
        },
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        const contentType = responseHeader(response, "content-type");
        const html = isHtmlContentType(contentType)
          ? await readLimitedText(response, controller.signal)
          : "";
        return { response, url: current, html };
      }
      const location = response.headers.get("location");
      if (!location)
        throw new Error(
          "The external site returned a redirect without a destination.",
        );
      current = validateExternalUrl(new URL(location, current).href, options);
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error("The external page inspection timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("The external site redirected too many times.");
}

export async function inspectExternalSite(url, options = {}) {
  const requested = validateExternalUrl(url, options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new Error("External inspection is unavailable in this runtime.");
  const studioOrigin = textValue(options.studioOrigin);
  const {
    response,
    url: finalUrl,
    html,
  } = await fetchWithRedirects(requested.href, fetchImpl, options);
  const contentType = responseHeader(response, "content-type");
  return analyzeExternalHtml({
    url: finalUrl.href,
    html,
    status: response.status,
    contentType,
    headers: response.headers,
    studioOrigin,
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES)
    throw Object.assign(new Error("Request body is too large."), {
      code: "request_too_large",
    });
  if (!request.body || typeof request.body.getReader !== "function") {
    const value = await request.text();
    if (new TextEncoder().encode(value).byteLength > MAX_REQUEST_BODY_BYTES)
      throw Object.assign(new Error("Request body is too large."), {
        code: "request_too_large",
      });
    return value;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, REQUEST_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES)
        throw Object.assign(new Error("Request body is too large."), {
          code: "request_too_large",
        });
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (timedOut)
      throw Object.assign(new Error("Request body read timed out."), {
        code: "request_timeout",
      });
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleExternalDiscovery(request) {
  if (request.method !== "POST")
    return jsonResponse({ error: "Only POST is supported." }, 405);
  const requestUrl = new URL(request.url);
  const requestOrigin = textValue(request.headers.get("origin")).trim();
  if (requestOrigin && requestOrigin !== requestUrl.origin)
    return jsonResponse(
      { error: "External inspection only accepts same-origin requests." },
      403,
    );
  let body;
  try {
    const rawBody = await readRequestBody(request);
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch (error) {
    if (errorCode(error) === "request_too_large")
      return jsonResponse(
        {
          error:
            error instanceof Error
              ? error.message
              : "Request body is too large.",
        },
        413,
      );
    if (errorCode(error) === "request_timeout")
      return jsonResponse(
        {
          error:
            error instanceof Error
              ? error.message
              : "Request body read timed out.",
        },
        408,
      );
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const rawTarget = textValue(body?.url).trim();
  if (!rawTarget)
    return jsonResponse({ error: "Missing url in request body." }, 400);
  try {
    const result = await inspectExternalSite(rawTarget, {
      studioOrigin: requestUrl.origin,
      requireHttps: requestUrl.protocol === "https:",
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      {
        status: "error",
        tools: [],
        frame: {
          status: "unknown",
          reason: "The page could not be inspected.",
        },
        previewHtml: "",
        error: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}
