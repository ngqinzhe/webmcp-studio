const MAX_HTML_BYTES = 1_250_000;
const MAX_PREVIEW_HTML_BYTES = 200_000;
const MAX_TOOLS = 24;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BODY_BYTES = 16_384;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const MAX_PARSED_ELEMENTS = 5_000;
const MAX_EVIDENCE = 4;
const MAX_TEXT_LENGTH = 720;
const MAX_NATIVE_SOURCE_LENGTH = 40_000;
const MAX_SCHEMA_PROPERTIES = 24;
const MAX_SELECT_OPTIONS = 40;
const MAX_NATIVE_SCRIPTS = 48;
const MAX_CARD_RECORDS = 120;
const MAX_FORM_RECORDS = 120;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const HTML_RAW_TEXT_TAGS = new Set(["script", "style", "template", "noscript"]);
const NON_VISIBLE_TAGS = new Set([...HTML_RAW_TEXT_TAGS, "svg"]);
const ACTION_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "tab",
]);
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

function safeToolName(value, fallback = "") {
  const normalized = textValue(value)
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z\d_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  const candidate = normalized || fallback;
  return TOOL_NAME_PATTERN.test(candidate) ? candidate : null;
}

function uniqueName(name, used) {
  const normalized = safeToolName(name);
  if (!normalized || used.has(normalized)) return null;
  used.add(normalized);
  return normalized;
}

function boundedText(value, limit = MAX_TEXT_LENGTH) {
  const raw = textValue(value);
  const normalized = normalizeWhitespace(
    raw.slice(0, Math.max(limit * 4, limit)),
  );
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized;
}

function normalizeWhitespace(value) {
  return decodeEntities(textValue(value)).replace(/\s+/g, " ").trim();
}

function slugifyName(value, fallback = "value") {
  return (
    safeToolName(value, safeToolName(fallback, "value")) ??
    safeToolName(fallback, "value") ??
    "value"
  );
}

function parseTagAttributes(source) {
  const attributes = Object.create(null);
  const pattern =
    /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1]?.toLowerCase() ?? "";
    if (!name || Object.hasOwn(attributes, name)) continue;
    attributes[name] = decodeEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    ).trim();
  }
  return attributes;
}

function readBalancedExpression(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  const opening = source[index];
  const pairs = { "{": "}", "[": "]", "(": ")" };
  if (!pairs[opening]) return null;
  const stack = [opening];
  let quote = "";
  for (index += 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 1;
      continue;
    }
    if (pairs[character]) {
      stack.push(character);
      continue;
    }
    if (Object.values(pairs).includes(character)) {
      if (pairs[stack.at(-1)] !== character) return null;
      stack.pop();
      if (stack.length === 0)
        return { value: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

function readLiteralValue(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  const first = source[index];
  if (first === '"' || first === "'" || first === "`") {
    const quote = first;
    let value = "";
    for (index += 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === "\\") {
        const escaped = source[++index];
        value +=
          escaped === "n"
            ? "\n"
            : escaped === "r"
              ? "\r"
              : escaped === "t"
                ? "\t"
                : (escaped ?? "");
      } else if (character === quote) {
        return {
          value: decodeEntities(value),
          raw: source.slice(start, index + 1),
          end: index + 1,
        };
      } else {
        value += character;
      }
    }
    return null;
  }
  if (first === "{" || first === "[" || first === "(")
    return readBalancedExpression(source, start);
  const token = source.slice(index).match(/^[^\s,}\]]+/)?.[0];
  return token
    ? {
        value: token,
        raw: source.slice(start, index + token.length),
        end: index + token.length,
      }
    : null;
}

function objectEntries(source) {
  const opening = textValue(source).indexOf("{");
  if (opening === -1) return [];
  const balanced = readBalancedExpression(source, opening);
  if (!balanced) return [];
  const body = balanced.value.slice(1, -1);
  const entries = [];
  let index = 0;
  while (index < body.length) {
    while (/\s|,/.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    let key;
    const keyValue = readLiteralValue(body, index);
    if (
      keyValue &&
      typeof keyValue.value === "string" &&
      ["'", '"', "`"].includes(body[index])
    ) {
      key = keyValue.value;
      index = keyValue.end;
    } else {
      const keyMatch = body.slice(index).match(/^[A-Za-z_$][\w$-]*/);
      if (!keyMatch) {
        const comma = body.indexOf(",", index);
        index = comma === -1 ? body.length : comma + 1;
        continue;
      }
      key = keyMatch[0];
      index += key.length;
    }
    while (/\s/.test(body[index] ?? "")) index += 1;
    if (body[index] !== ":") {
      const comma = body.indexOf(",", index);
      index = comma === -1 ? body.length : comma + 1;
      continue;
    }
    const value = readLiteralValue(body, index + 1);
    if (!value) break;
    entries.push({ key, raw: value.raw ?? value.value, value: value.value });
    index = value.end;
  }
  return entries;
}

function objectProperty(source, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return objectEntries(source).find((entry) =>
    wanted.has(entry.key.toLowerCase()),
  );
}

function literalString(source) {
  const value = readLiteralValue(textValue(source), 0);
  return value && typeof value.value === "string" ? value.value : "";
}

function extractSchemaFromSource(source) {
  const schemaSource =
    objectProperty(source, ["inputSchema", "input_schema", "parameters"])
      ?.raw ?? source;
  const propertiesSource = objectProperty(schemaSource, ["properties"])?.raw;
  const properties = {};
  for (const entry of (propertiesSource
    ? objectEntries(propertiesSource)
    : []
  ).slice(0, MAX_SCHEMA_PROPERTIES)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(
        entry.key.toLowerCase(),
      )
    )
      continue;
    const definition = entry.raw;
    const typeValue = objectProperty(definition, ["type"]);
    const type = literalString(typeValue?.raw ?? "").toLowerCase();
    if (!/^(?:string|number|integer|boolean|array|object)$/.test(type))
      continue;
    const description = literalString(
      objectProperty(definition, ["description"])?.raw ?? "",
    );
    const property = schemaProperty(
      type,
      description || "Parameter from the page's WebMCP declaration.",
    );
    const enumSource = objectProperty(definition, ["enum"])?.raw;
    if (enumSource) {
      property.enum = Array.from(
        enumSource.matchAll(/["'`]([^"'`]{1,120})["'`]/g),
      )
        .map((match) => decodeEntities(match[1]))
        .slice(0, 24);
    }
    properties[entry.key] = property;
  }
  const requiredSource = objectProperty(schemaSource, ["required"])?.raw ?? "";
  const required = Array.from(
    requiredSource.matchAll(/["'`]([A-Za-z_$][\w$-]{0,63})["'`]/g),
  )
    .map((entry) => entry[1])
    .slice(0, MAX_SCHEMA_PROPERTIES);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: Array.from(new Set(required)) } : {}),
    additionalProperties: false,
  };
}

function objectExpressions(value) {
  const source = textValue(value).trim();
  if (source.startsWith("{")) {
    const object = readBalancedExpression(source, 0);
    return object ? [object.value] : [];
  }
  if (!source.startsWith("[")) return [];
  const objects = [];
  let index = 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      const literal = readLiteralValue(source, index);
      index = literal?.end ?? source.length;
      continue;
    }
    if (character === "{") {
      const object = readBalancedExpression(source, index);
      if (!object) break;
      objects.push(object.value);
      index = object.end;
      continue;
    }
    index += 1;
  }
  return objects;
}

function escapeRegExp(value) {
  return textValue(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveNativeArgument(argument, source, before) {
  const identifier = argument.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
  if (!identifier) return argument;
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(identifier)}\\s*=\\s*`,
    "g",
  );
  let match;
  let latest = null;
  while ((match = declaration.exec(source)) !== null && match.index < before)
    latest = match;
  if (!latest) return argument;
  const expression = readBalancedExpression(
    source,
    latest.index + latest[0].length,
  );
  return expression?.value ?? argument;
}

function nativeScriptSources(html) {
  const sources = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while (
    (match = pattern.exec(html)) !== null &&
    sources.length < MAX_NATIVE_SCRIPTS
  )
    sources.push(textValue(match[1]).slice(0, MAX_NATIVE_SOURCE_LENGTH));
  if (sources.length === 0)
    sources.push(textValue(html).slice(0, MAX_NATIVE_SOURCE_LENGTH));
  return sources;
}

function maskJavaScriptLiterals(source) {
  const characters = textValue(source).split("");
  let quote = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      if (character === "\\") {
        characters[index] = " ";
        if (index + 1 < characters.length) characters[++index] = " ";
      } else if (character === quote) {
        characters[index] = " ";
        quote = "";
      } else if (character !== "\n" && character !== "\r") {
        characters[index] = " ";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      characters[index] = " ";
      quote = character;
      continue;
    }
    if (character === "/" && characters[index + 1] === "/") {
      characters[index] = " ";
      characters[++index] = " ";
      while (
        index + 1 < characters.length &&
        !/[\n\r]/.test(characters[index + 1])
      )
        characters[++index] = " ";
      continue;
    }
    if (character === "/" && characters[index + 1] === "*") {
      characters[index] = " ";
      characters[++index] = " ";
      while (index + 1 < characters.length) {
        if (characters[index + 1] === "*" && characters[index + 2] === "/") {
          characters[++index] = " ";
          characters[++index] = " ";
          break;
        }
        characters[++index] = " ";
      }
    }
  }
  return characters.join("");
}

function nativeToolsFromHtml(html, used) {
  const tools = [];
  const registrationPattern =
    /(?:\b(?:navigator|window\.navigator|document|window|globalThis)\s*\.\s*)?\bmodelContext\s*\.\s*(provideTool|provideTools|registerTool|registerTools)\s*\(/gi;
  for (const source of nativeScriptSources(html)) {
    const searchableSource = maskJavaScriptLiterals(source);
    let match;
    while (
      (match = registrationPattern.exec(searchableSource)) !== null &&
      tools.length < MAX_TOOLS
    ) {
      const call = readBalancedExpression(
        source,
        registrationPattern.lastIndex - 1,
      );
      if (!call) continue;
      const argument = resolveNativeArgument(
        call.value.slice(1, -1),
        source,
        match.index,
      );
      for (const declaration of objectExpressions(argument)) {
        if (tools.length >= MAX_TOOLS) break;
        const name = uniqueName(
          objectProperty(declaration, ["name"])?.value,
          used,
        );
        if (!name) continue;
        const description = boundedText(
          literalString(
            objectProperty(declaration, ["description"])?.raw ?? "",
          ) || "Declared by the page through its WebMCP model context.",
          280,
        );
        tools.push({
          name,
          description,
          inputSchema: extractSchemaFromSource(declaration),
          annotations: { readOnlyHint: true },
          // A fetched script is only evidence of a potential declaration. The
          // browser's live modelContext cannot be observed across origins, so
          // an external result must never be presented as a verified Native tool.
          source: "manual",
          confidence: 0.86,
          evidence: [
            {
              type: "manual",
              selector: "script",
              note: `Fetched page source contains a potential ${match[1]} WebMCP registration; verify it on the live origin.`,
            },
          ],
        });
      }
      registrationPattern.lastIndex = call.end;
    }
  }
  return tools;
}

function parseHtmlEvidence(html) {
  const source = textValue(html);
  const root = {
    tagName: "#document",
    attrs: {},
    rawTag: "",
    parent: null,
    children: [],
    start: 0,
    openEnd: 0,
    closeStart: source.length,
    end: source.length,
  };
  const elements = [];
  const stack = [root];
  let cursor = 0;

  while (cursor < source.length && elements.length < MAX_PARSED_ELEMENTS) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) break;
    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findPreviewTagEnd(source, tagStart + 1);
    if (tagEnd === -1) break;
    const rawTag = source.slice(tagStart, tagEnd + 1);
    const tagMatch = rawTag.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
    if (!tagMatch) {
      cursor = tagEnd + 1;
      continue;
    }

    const tagName = tagMatch[2].toLowerCase();
    if (tagMatch[1] === "/") {
      let matchedIndex = -1;
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]?.tagName === tagName) {
          matchedIndex = index;
          break;
        }
      }
      if (matchedIndex !== -1) {
        for (let index = stack.length - 1; index >= matchedIndex; index -= 1) {
          const record = stack.pop();
          if (!record) continue;
          record.closeStart = tagStart;
          record.end = tagEnd + 1;
        }
      }
      cursor = tagEnd + 1;
      continue;
    }

    const attributeSource = rawTag
      .slice(tagMatch[0].length, -1)
      .replace(/\/\s*$/, "");
    const record = {
      tagName,
      attrs: parseTagAttributes(attributeSource),
      rawTag,
      parent: stack.at(-1) ?? root,
      children: [],
      start: tagStart,
      openEnd: tagEnd + 1,
      closeStart: source.length,
      end: source.length,
    };
    record.parent.children.push(record);
    elements.push(record);

    const selfClosing = /\/\s*>$/.test(rawTag);
    if (selfClosing || HTML_VOID_TAGS.has(tagName)) {
      record.closeStart = tagEnd + 1;
      record.end = tagEnd + 1;
      cursor = tagEnd + 1;
      continue;
    }

    if (NON_VISIBLE_TAGS.has(tagName)) {
      const closingPattern = new RegExp(`</\\s*${tagName}\\s*>`, "ig");
      closingPattern.lastIndex = tagEnd + 1;
      const closingMatch = closingPattern.exec(source);
      if (closingMatch) {
        record.closeStart = closingMatch.index;
        record.end = closingMatch.index + closingMatch[0].length;
        cursor = record.end;
      } else {
        record.closeStart = source.length;
        record.end = source.length;
        cursor = source.length;
      }
      continue;
    }

    stack.push(record);
    cursor = tagEnd + 1;
  }

  for (let index = stack.length - 1; index > 0; index -= 1) {
    const record = stack[index];
    if (record) {
      record.closeStart = source.length;
      record.end = source.length;
    }
  }
  return { source, root, elements };
}

function visibleText(value) {
  const withoutNonVisible = textValue(value)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*$/gi, " ");
  return normalizeWhitespace(stripTags(withoutNonVisible));
}

function recordText(record, parsed) {
  return boundedText(
    visibleText(
      parsed.source.slice(
        record.openEnd,
        record.closeStart ?? parsed.source.length,
      ),
    ),
  );
}

function recordAttribute(record, name) {
  return textValue(record?.attrs?.[name.toLowerCase()]);
}

function hasRecordAttribute(record, name) {
  return Object.hasOwn(record?.attrs ?? {}, name.toLowerCase());
}

function recordSelector(record, parsed) {
  const id = recordAttribute(record, "id");
  if (id) return `#${id}`;
  const testId =
    recordAttribute(record, "data-testid") ||
    recordAttribute(record, "data-test") ||
    recordAttribute(record, "data-cy");
  if (testId) return `[data-testid="${testId}"]`;
  for (const attributeName of [
    "data-product-id",
    "data-option-id",
    "data-item-id",
    "data-sku",
    "data-flight-id",
    "data-hotel-id",
  ]) {
    const value = recordAttribute(record, attributeName);
    if (value) return `[${attributeName}="${value}"]`;
  }
  const name = recordAttribute(record, "name");
  if (name) return `[name="${name}"]`;
  const index = parsed.elements.filter(
    (candidate) =>
      candidate.tagName === record.tagName && candidate.start <= record.start,
  ).length;
  return `${record.tagName}:nth-of-type(${Math.max(index, 1)})`;
}

function referencedText(record, parsed, id) {
  const target = parsed.elements.find(
    (candidate) => recordAttribute(candidate, "id") === id,
  );
  return target ? recordText(target, parsed) : "";
}

function recordLabel(record, parsed) {
  const labelledBy = recordAttribute(record, "aria-labelledby")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => referencedText(record, parsed, id));
  const associatedLabels = parsed.elements
    .filter(
      (candidate) =>
        candidate.tagName === "label" &&
        recordAttribute(candidate, "for") === recordAttribute(record, "id"),
    )
    .map((candidate) => recordText(candidate, parsed));
  const parentLabel =
    record.parent?.tagName === "label" ? recordText(record.parent, parsed) : "";
  const descendants = parsed.elements
    .filter(
      (candidate) =>
        candidate.tagName === "img" &&
        isDescendant(candidate, record) &&
        recordAttribute(candidate, "alt"),
    )
    .map((candidate) => recordAttribute(candidate, "alt"));
  const values = [
    recordAttribute(record, "aria-label"),
    ...labelledBy,
    ...associatedLabels,
    parentLabel,
    recordText(record, parsed),
    recordAttribute(record, "title"),
    recordAttribute(record, "placeholder"),
    recordAttribute(record, "value"),
    ...descendants,
  ];
  return Array.from(
    new Set(values.map(normalizeWhitespace).filter(Boolean)),
  ).join(" ");
}

function recordMeta(record) {
  const data = Object.entries(record.attrs ?? {})
    .filter(([name]) => name.startsWith("data-") || name.startsWith("aria-"))
    .map(([name, value]) => `${name} ${value}`);
  return normalizeWhitespace(
    [
      recordAttribute(record, "id"),
      recordAttribute(record, "name"),
      recordAttribute(record, "class"),
      recordAttribute(record, "role"),
      recordAttribute(record, "type"),
      recordAttribute(record, "href"),
      recordAttribute(record, "action"),
      ...data,
    ].join(" "),
  );
}

function isDescendant(record, ancestor) {
  let current = record.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function ancestors(record) {
  const result = [];
  let current = record.parent;
  while (current && current.tagName !== "#document") {
    result.push(current);
    current = current.parent;
  }
  return result;
}

function descendants(record, parsed) {
  return parsed.elements.filter((candidate) => isDescendant(candidate, record));
}

function cardLike(record, parsed) {
  const signal = recordMeta(record).toLowerCase();
  if (["article", "li"].includes(record.tagName)) return true;
  if (["article", "listitem"].includes(recordAttribute(record, "role")))
    return true;
  if (
    Object.keys(record.attrs).some((name) =>
      /^data-(?:product|item|sku|flight|hotel|offer|option|property|id)(?:-|$)/.test(
        name,
      ),
    )
  )
    return true;
  return /(?:product[-_ ]?(?:card|tile)|listing[-_ ]?(?:card|item)|result[-_ ]?(?:card|item)|offer[-_ ]?card|flight[-_ ]?card|hotel[-_ ]?card|option[-_ ]?card|property[-_ ]?card|item[-_ ]?card|\b(?:product|item|result|offer|option)\b|\bcard\b|\btile\b)/i.test(
    signal,
  );
}

function nearestCard(record, parsed) {
  let current = record;
  while (current && current.tagName !== "#document") {
    if (cardLike(current, parsed)) return current;
    current = current.parent;
  }
  return null;
}

function cardSignature(record) {
  const classes = recordAttribute(record, "class")
    .toLowerCase()
    .split(/\s+/)
    .filter((value) =>
      /(?:card|tile|product|listing|result|offer|flight|hotel|option|property|item)/.test(
        value,
      ),
    )
    .slice(0, 3)
    .join(".");
  return `${record.tagName}|${recordAttribute(record, "role")}|${classes}`;
}

function repeatedCards(parsed) {
  const cards = parsed.elements.filter((record) => cardLike(record, parsed));
  const groups = new Map();
  for (const card of cards) {
    const signature = cardSignature(card);
    const group = groups.get(signature) ?? [];
    group.push(card);
    groups.set(signature, group);
  }
  const repeated = Array.from(groups.values())
    .filter((group) => group.length >= 2)
    .flat();
  return repeated.length > 0 ? repeated : cards.length >= 2 ? cards : [];
}

function controlRecords(form, parsed) {
  return parsed.elements.filter(
    (record) =>
      isDescendant(record, form) &&
      ["input", "select", "textarea"].includes(record.tagName),
  );
}

function interactiveRecords(parsed) {
  return parsed.elements.filter((record) => {
    const role = recordAttribute(record, "role").toLowerCase();
    if (ACTION_ROLES.has(role)) return true;
    if (
      ["button", "a", "summary"].includes(record.tagName) ||
      ["input", "select", "textarea"].includes(record.tagName)
    )
      return true;
    return Boolean(
      recordAttribute(record, "data-action") ||
      recordAttribute(record, "data-webmcp-action") ||
      recordAttribute(record, "data-tool"),
    );
  });
}

function controlType(record) {
  return recordAttribute(record, "type").toLowerCase() || "text";
}

function isSubmitControl(record) {
  return (
    record.tagName === "button" ||
    (record.tagName === "input" &&
      ["submit", "image", "button"].includes(controlType(record))) ||
    recordAttribute(record, "role").toLowerCase() === "button"
  );
}

function fieldNameForRecord(record, fallback = "value") {
  return slugifyName(
    recordAttribute(record, "name") ||
      recordAttribute(record, "id") ||
      recordAttribute(record, "aria-label") ||
      recordAttribute(record, "placeholder") ||
      fallback,
    fallback,
  );
}

function numberAttribute(record, name) {
  const rawValue = recordAttribute(record, name);
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : undefined;
}

function optionValues(record, parsed) {
  return descendants(record, parsed)
    .filter((candidate) => candidate.tagName === "option")
    .map(
      (option) =>
        recordAttribute(option, "value") || recordText(option, parsed),
    )
    .map(normalizeWhitespace)
    .filter(Boolean)
    .slice(0, MAX_SELECT_OPTIONS);
}

function schemaForControl(record, parsed) {
  const type = controlType(record);
  const label = recordLabel(record, parsed);
  let schema;
  if (record.tagName === "select") {
    const values = Array.from(new Set(optionValues(record, parsed)));
    if (hasRecordAttribute(record, "multiple")) {
      schema = { type: "array", items: { type: "string" } };
      if (values.length > 0) schema.items = { type: "string", enum: values };
    } else {
      schema = { type: "string" };
      if (values.length > 0) schema.enum = values;
    }
  } else if (record.tagName === "textarea") {
    schema = { type: "string" };
  } else if (type === "checkbox") {
    schema = { type: "boolean" };
  } else if (type === "radio") {
    schema = {
      type: "string",
      ...(recordAttribute(record, "value")
        ? { enum: [recordAttribute(record, "value")] }
        : {}),
    };
  } else if (["number", "range"].includes(type)) {
    schema = { type: "number" };
  } else {
    schema = { type: "string" };
    if (type === "email") schema.format = "email";
    if (type === "url") schema.format = "uri";
    if (type === "date") schema.format = "date";
    if (type === "datetime-local") schema.format = "date-time";
    if (type === "time") schema.format = "time";
  }
  const minimum = numberAttribute(record, "min");
  const maximum = numberAttribute(record, "max");
  const minLength = numberAttribute(record, "minlength");
  const maxLength = numberAttribute(record, "maxlength");
  if (minimum !== undefined && schema.type === "number")
    schema.minimum = minimum;
  if (maximum !== undefined && schema.type === "number")
    schema.maximum = maximum;
  if (minLength !== undefined && schema.type === "string")
    schema.minLength = Math.max(0, Math.floor(minLength));
  if (maxLength !== undefined && schema.type === "string")
    schema.maxLength = Math.max(0, Math.floor(maxLength));
  if (label) schema.description = `Value for ${boundedText(label, 120)}`;
  return schema;
}

function schemaForControls(controls, parsed, options = {}) {
  const properties = {};
  const required = [];
  const counts = new Map();
  for (const control of controls) {
    if (Object.keys(properties).length >= MAX_SCHEMA_PROPERTIES) break;
    if (
      isSubmitControl(control) ||
      ["reset", "file"].includes(controlType(control))
    )
      continue;
    const base = fieldNameForRecord(control, control.tagName);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const field = count === 1 ? base : `${base}_${count}`;
    properties[field] = schemaForControl(control, parsed);
    if (hasRecordAttribute(control, "required")) required.push(field);
  }
  const schema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: Array.from(new Set(required)) } : {}),
    additionalProperties: false,
  };
  if (options.description) schema.description = options.description;
  return schema;
}

function emptySchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

function itemKey(subject) {
  if (subject === "products") return "productId";
  if (subject === "options") return "optionId";
  if (subject === "articles") return "articleId";
  return "itemId";
}

function actionSchema(name, subject, record, parsed, repeated = false) {
  if (name === "add_to_cart") {
    const properties = {
      quantity: { type: "integer", minimum: 1, default: 1 },
    };
    const card = nearestCard(record, parsed);
    if (card && subject === "products")
      properties.productId = {
        type: "string",
        description: "Observed product identifier, when the page exposes one.",
      };
    return {
      type: "object",
      properties,
      ...(card && subject === "products" && repeated
        ? { required: ["productId"] }
        : {}),
      additionalProperties: false,
    };
  }
  if (["get_product", "get_details", "open_item"].includes(name)) {
    const key = itemKey(subject);
    return {
      type: "object",
      properties: {
        [key]: {
          type: "string",
          description: `Identifier for the ${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"}.`,
        },
      },
      ...(repeated ? { required: [key] } : {}),
      additionalProperties: false,
    };
  }
  if (name === "select_option")
    return {
      type: "object",
      properties: {
        optionId: { type: "string", description: "Visible option identifier." },
      },
      required: ["optionId"],
      additionalProperties: false,
    };
  if (["remove_from_cart", "view_wishlist"].includes(name)) {
    const key = itemKey(subject);
    return {
      type: "object",
      properties: {
        [key]: { type: "string", description: "Visible item identifier." },
      },
      additionalProperties: false,
    };
  }
  if (["next_page", "previous_page"].includes(name))
    return {
      type: "object",
      properties: { page: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    };
  return emptySchema();
}

function isTravelLocationControl(record, parsed) {
  const signal =
    `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordLabel(record, parsed)}`.toLowerCase();
  return /(?:^|[\s_-])(?:origin|destination|from|to|departure|arrival|depart|return|check[-_ ]?in|check[-_ ]?out)(?:$|[\s_-])/.test(
    signal,
  );
}

function pageContext(parsed, url) {
  const title = parsed.elements.find((record) => record.tagName === "title");
  const headings = parsed.elements
    .filter((record) => /^h[1-3]$/.test(record.tagName))
    .map((record) => recordText(record, parsed));
  const forms = parsed.elements.filter((record) => record.tagName === "form");
  const controls = parsed.elements.filter((record) =>
    ["input", "select", "textarea"].includes(record.tagName),
  );
  const cards = parsed.elements.filter((record) => cardLike(record, parsed));
  const repeated = repeatedCards(parsed);
  const pageSignal = normalizeWhitespace(
    [
      title ? recordText(title, parsed) : "",
      ...headings,
      visibleText(parsed.source).slice(0, 4_000),
      textValue(url),
    ].join(" "),
  ).toLowerCase();
  const cardSignal = cards
    .slice(0, 12)
    .map((card) => `${recordMeta(card)} ${recordText(card, parsed)}`)
    .join(" ")
    .toLowerCase();
  const allSignal = `${pageSignal} ${cardSignal}`;
  const travelFields = controls.filter(
    (record) =>
      isTravelLocationControl(record, parsed) ||
      /(?:travel|passenger|guests?)/.test(
        `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordLabel(record, parsed)}`.toLowerCase(),
      ),
  );
  const productCardEvidence = cards.some((card) => {
    const signal =
      `${recordMeta(card)} ${recordText(card, parsed)}`.toLowerCase();
    return (
      /(?:product|sku|catalog|add\s+to\s+(?:cart|bag)|price)/.test(signal) ||
      /[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(?:usd|sgd|eur|gbp)\b/.test(signal)
    );
  });
  const travelCardEvidence = cards.some((card) =>
    /(?:flight|hotel|room|fare|itinerary|departure|arrival|airline|destination|option|reserve|book)/.test(
      `${recordMeta(card)} ${recordText(card, parsed)}`.toLowerCase(),
    ),
  );
  const productDataEvidence = parsed.elements.some((record) =>
    Object.keys(record.attrs).some((name) =>
      /^data-(?:product|sku|price|catalog)(?:-|$)/.test(name),
    ),
  );
  const hasFilterControls = controls.some((record) =>
    /(?:filter|category|brand|availability|rating|price|stops|airline|amenit)/.test(
      `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordLabel(record, parsed)}`.toLowerCase(),
    ),
  );
  const travelFormEvidence = forms.some((form) => {
    const formControls = controlRecords(form, parsed);
    const signal =
      `${recordMeta(form)} ${recordText(form, parsed)}`.toLowerCase();
    const locationFields = formControls.filter((record) =>
      isTravelLocationControl(record, parsed),
    );
    return (
      locationFields.length >= 2 ||
      (locationFields.length > 0 &&
        /(?:flight|hotel|booking|travel)/.test(signal))
    );
  });
  const strongTravel = travelCardEvidence || travelFormEvidence;
  const strongProducts =
    productCardEvidence ||
    productDataEvidence ||
    (cards.length > 0 &&
      hasFilterControls &&
      /(?:product|catalog|shop|price|cart)/.test(allSignal));
  const subject = strongTravel
    ? "options"
    : strongProducts
      ? "products"
      : /(?:article|story|post|news)/.test(allSignal) && cards.length > 0
        ? "articles"
        : "items";
  return {
    subject,
    strong: strongTravel || strongProducts || subject === "articles",
    cards,
    repeatedCards: repeated,
    travelFields,
    pageSignal: allSignal,
  };
}

function subjectForRecord(record, parsed, context) {
  const card = nearestCard(record, parsed);
  const signal = card
    ? `${recordMeta(card)} ${recordText(card, parsed)}`.toLowerCase()
    : "";
  if (
    /(?:flight|hotel|room|fare|itinerary|departure|arrival|airline|destination|reserve|booking)/.test(
      signal,
    )
  )
    return "options";
  if (/(?:product|sku|catalog|price|cart|add\s+to\s+(?:cart|bag))/.test(signal))
    return "products";
  return context.strong ? context.subject : "items";
}

function searchToolName(subject) {
  return subject === "items" ? "search_content" : `search_${subject}`;
}

function filterToolName(subject) {
  return subject === "items" ? "filter_results" : `filter_${subject}`;
}

function detailToolName(subject) {
  if (subject === "products") return "get_product";
  if (subject === "options") return "get_details";
  return "open_item";
}

function evidence(record, parsed, note, type = "dom") {
  return {
    type,
    selector: record ? recordSelector(record, parsed) : "document",
    note: boundedText(note, 240),
  };
}

function potentialTool({
  name,
  description,
  inputSchema,
  record,
  parsed,
  note,
  confidence = 0.7,
  destructive = false,
  type = "dom",
}) {
  return {
    name,
    description,
    inputSchema,
    annotations: destructive
      ? { destructiveHint: true }
      : { readOnlyHint: true },
    source: "dom",
    confidence,
    evidence: [evidence(record, parsed, note, type)],
  };
}

function schemaScore(schema) {
  if (!schema || typeof schema !== "object") return 0;
  const properties = schema.properties;
  const required = schema.required;
  return (
    (properties && typeof properties === "object"
      ? Object.keys(properties).length
      : 0) + (Array.isArray(required) ? required.length : 0)
  );
}

function isSearchControl(record, parsed) {
  const type = controlType(record);
  const signal =
    `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordAttribute(record, "placeholder")} ${recordAttribute(record, "aria-label")} ${recordLabel(record, parsed)}`.toLowerCase();
  return (
    type === "search" ||
    /(?:search|query|keyword|find)/.test(signal) ||
    ["q", "query", "search"].includes(
      recordAttribute(record, "name").toLowerCase(),
    )
  );
}

function isFilterControl(record, parsed) {
  const signal =
    `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordAttribute(record, "class")} ${recordLabel(record, parsed)}`.toLowerCase();
  if (
    /(?:filter|facet|category|brand|availability|rating|in\s+stock|on\s+sale|free\s+shipping|price(?:[-_ ]?(?:min|max|range))?|(?:min|max)[-_ ]?price|stops|airline|amenit|refine)/.test(
      signal,
    )
  )
    return true;
  return (
    ["checkbox", "radio"].includes(controlType(record)) &&
    ancestors(record).some((ancestor) =>
      /(?:filter|facet|sidebar|refine)/.test(
        recordMeta(ancestor).toLowerCase(),
      ),
    )
  );
}

function isSortControl(record, parsed) {
  return /(?:sort|order(?:ing)?|order[-_ ]?by)/.test(
    `${recordAttribute(record, "name")} ${recordAttribute(record, "id")} ${recordAttribute(record, "class")} ${recordLabel(record, parsed)}`.toLowerCase(),
  );
}

function explicitAction(record) {
  return (
    recordAttribute(record, "data-webmcp-action") ||
    recordAttribute(record, "data-action") ||
    recordAttribute(record, "data-tool")
  ).trim();
}

function explicitActionName(value, subject) {
  const token = safeToolName(value);
  if (!token) return undefined;
  if (token === "search") return searchToolName(subject);
  if (["filter", "apply_filter", "apply_filters", "refine"].includes(token))
    return filterToolName(subject);
  if (["sort", "sort_results", "order_by"].includes(token))
    return "change_sort";
  if (
    [
      "view_product",
      "product_details",
      "product_detail",
      "view_details",
      "details",
    ].includes(token)
  )
    return detailToolName(subject);
  if (["select", "book", "reserve", "choose", "select_option"].includes(token))
    return "select_option";
  if (["itinerary", "view_itinerary", "trip_summary"].includes(token))
    return "view_itinerary";
  if (["cart", "view_cart", "view_bag", "view_basket"].includes(token))
    return "view_cart";
  if (
    ["add", "add_to_cart", "add_to_bag", "buy_now", "purchase"].includes(token)
  )
    return "add_to_cart";
  if (["remove", "remove_from_cart", "remove_from_bag"].includes(token))
    return "remove_from_cart";
  if (["wishlist", "favorite", "favourite", "save"].includes(token))
    return "view_wishlist";
  return token;
}

function itemLinkEvidence(record, card, parsed) {
  if (!card || record.tagName !== "a" || !recordAttribute(record, "href"))
    return false;
  const href = recordAttribute(record, "href").toLowerCase();
  const cardSignal =
    `${recordMeta(card)} ${recordText(card, parsed)}`.toLowerCase();
  return (
    /(?:product|item|listing|sku|flight|hotel|room|offer|option|property)/.test(
      href,
    ) ||
    /(?:price|sku|product|flight|hotel|room|offer|option|property)/.test(
      cardSignal,
    )
  );
}

function actionDescriptor(record, parsed, context, repeated) {
  const label = recordLabel(record, parsed);
  const explicit = explicitAction(record);
  const meta = recordMeta(record);
  const semantic = `${label} ${meta}`.toLowerCase();
  const normalizedSemantic = semantic.replace(/[-_]/g, " ");
  const subject = subjectForRecord(record, parsed, context);
  const card = nearestCard(record, parsed);
  const repeatedCard = Boolean(card && repeated.includes(card));
  const add = (name, description, destructive = false, confidence = 0.7) =>
    potentialTool({
      name,
      description,
      inputSchema: actionSchema(name, subject, record, parsed, repeatedCard),
      record,
      parsed,
      note: explicit
        ? `Observed ${record.tagName} action ${explicit} (${label || "unlabelled control"}).`
        : `Observed action label: ${boundedText(label || meta, 120)}.`,
      confidence,
      destructive,
    });

  const fromData = explicit ? explicitActionName(explicit, subject) : undefined;
  if (fromData === "search_content" || fromData?.startsWith("search_"))
    return add(fromData, `Potentially search ${subject}.`, false, 0.8);
  if (fromData?.startsWith("filter_"))
    return add(fromData, `Potentially filter ${subject}.`, false, 0.78);
  if (fromData === "change_sort")
    return add(fromData, "Potentially change result ordering.", false, 0.78);
  if (fromData === "add_to_cart")
    return add(
      fromData,
      "Potentially add the visible item to a cart or bag.",
      true,
      0.78,
    );
  if (fromData === "remove_from_cart")
    return add(
      fromData,
      "Potentially remove the visible item from a cart or bag.",
      true,
      0.76,
    );
  if (fromData === "view_cart")
    return add(
      fromData,
      "Potentially open the page's visible cart or bag.",
      false,
      0.76,
    );
  if (fromData === "select_option")
    return add(
      fromData,
      "Potentially select the visible option for the page's flow.",
      true,
      0.72,
    );
  if (fromData === "view_itinerary")
    return add(
      fromData,
      "Potentially open the visible itinerary or trip summary.",
      false,
      0.78,
    );
  if (fromData === "view_wishlist")
    return add(
      fromData,
      "Potentially save the visible item for later.",
      true,
      0.72,
    );
  if (
    fromData === "get_product" ||
    fromData === "get_details" ||
    fromData === "open_item"
  )
    return add(
      fromData,
      `Potentially open details for the visible ${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"}.`,
      false,
      0.78,
    );
  if (fromData && explicit)
    return add(
      fromData,
      `Potentially invoke the page's ${explicit} action.`,
      false,
      0.62,
    );

  if (
    /(?:add|put|save)\s+(?:to|in)\s+(?:the\s+)?(?:cart|basket|bag)|\badd_to_cart\b|\b(?:buy|purchase)\s+now\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "add_to_cart",
      "Potentially add the visible item to a cart or bag.",
      true,
      0.76,
    );
  if (
    card &&
    subject === "products" &&
    /\b(?:buy|purchase)\b/.test(normalizedSemantic)
  )
    return add(
      "add_to_cart",
      "Potentially add the visible item to a cart or bag.",
      true,
      0.72,
    );
  if (
    /(?:remove|delete)\s+(?:from|in)\s+(?:the\s+)?(?:cart|basket|bag)|\bremove_from_cart\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "remove_from_cart",
      "Potentially remove the visible item from a cart or bag.",
      true,
      0.74,
    );
  if (
    /\b(?:view|open|show)\s+(?:my\s+)?(?:cart|bag|basket)\b|\b(?:cart|bag|basket)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "view_cart",
      "Potentially open the page's visible cart or bag.",
      false,
      0.72,
    );
  if (/\b(?:checkout|place\s+order)\b/.test(normalizedSemantic))
    return add("checkout", "Potentially proceed to checkout.", true, 0.74);
  if (
    /\b(?:wishlist|wish\s+list|favorite|favourite|save\s+for\s+later)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "view_wishlist",
      "Potentially save the visible item for later.",
      true,
      0.7,
    );
  if (/\b(?:search|find)\b/.test(normalizedSemantic))
    return add(
      searchToolName(subject),
      `Potentially search ${subject}.`,
      false,
      0.76,
    );
  if (
    /\b(?:filter|filters|facet|refine|apply\s+filters?)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      filterToolName(subject),
      `Potentially filter ${subject}.`,
      false,
      0.76,
    );
  if (/\b(?:sort|order\s+by|relevance)\b/.test(normalizedSemantic))
    return add(
      "change_sort",
      "Potentially change the visible result ordering.",
      false,
      0.74,
    );
  if (/\b(?:clear|reset)\s+(?:all\s+)?filters?\b/.test(normalizedSemantic))
    return add(
      "clear_filters",
      "Potentially clear the visible result filters.",
      false,
      0.7,
    );
  if (
    /\b(?:view|open|show)\s+(?:my\s+)?(?:itinerary|trip|trips|booking|bookings?)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "view_itinerary",
      "Potentially open the visible itinerary or trip summary.",
      false,
      0.78,
    );
  if (/\b(?:book|reserve|select|choose)\b/.test(normalizedSemantic))
    return add(
      "select_option",
      "Potentially select the visible option for the page's flow.",
      true,
      0.68,
    );
  if (
    /\b(?:next|more\s+results?|load\s+more|show\s+more)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "next_page",
      "Potentially load the next set of visible results.",
      false,
      0.7,
    );
  if (/\b(?:previous|back)\b/.test(normalizedSemantic))
    return add(
      "previous_page",
      "Potentially open the previous set of results.",
      false,
      0.68,
    );
  if (/\b(?:sign[ -]?in|log[ -]?in|authenticate)\b/.test(normalizedSemantic))
    return add(
      "sign_in",
      "Potentially sign in through the visible page UI.",
      true,
      0.7,
    );
  if (
    /\b(?:contact|send\s+(?:message|inquiry)|feedback)\b/.test(
      normalizedSemantic,
    )
  )
    return add(
      "submit_contact_form",
      "Potentially submit the visible contact interaction.",
      true,
      0.7,
    );
  if (/\b(?:subscribe|newsletter|mailing\s+list)\b/.test(normalizedSemantic))
    return add(
      "subscribe",
      "Potentially subscribe through the visible page UI.",
      true,
      0.68,
    );

  if (
    card &&
    /\b(?:details?|learn\s+more|more\s+info)\b/.test(normalizedSemantic)
  ) {
    const name = detailToolName(subject);
    return add(
      name,
      `Potentially open details for the visible ${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"}.`,
      false,
      0.72,
    );
  }

  if (
    card &&
    /\b(?:view|open|show|see)\b/.test(normalizedSemantic) &&
    /\b(?:product|item|option|flight|hotel|details?|fare)\b/.test(
      normalizedSemantic,
    )
  ) {
    const name = detailToolName(subject);
    return add(
      name,
      `Potentially open details for the visible ${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"}.`,
      false,
      0.72,
    );
  }

  if (itemLinkEvidence(record, card, parsed)) {
    const name = detailToolName(subject);
    return add(
      name,
      `Potentially open details for the visible ${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"}.`,
      false,
      0.7,
    );
  }
  return undefined;
}

function formDescription(form, parsed) {
  return (
    recordAttribute(form, "aria-label") ||
    recordAttribute(form, "name") ||
    recordAttribute(form, "id") ||
    recordAttribute(form, "action") ||
    "visible page"
  );
}

function inferredToolsFromHtml(html, used, url = "") {
  const parsed = parseHtmlEvidence(html);
  const context = pageContext(parsed, url);
  const tools = [];
  const byName = new Map();
  const add = (tool) => {
    const name = safeToolName(tool.name);
    if (!name) return;
    const existing = byName.get(name);
    if (existing) {
      const evidenceValues = [
        ...(existing.evidence ?? []),
        ...(tool.evidence ?? []),
      ];
      const seenEvidence = new Set();
      existing.evidence = evidenceValues
        .filter((entry) => {
          const key = `${entry.selector ?? ""}|${entry.note}`;
          if (seenEvidence.has(key)) return false;
          seenEvidence.add(key);
          return true;
        })
        .slice(0, MAX_EVIDENCE);
      existing.confidence = Math.max(
        existing.confidence ?? 0,
        tool.confidence ?? 0,
      );
      if (schemaScore(tool.inputSchema) > schemaScore(existing.inputSchema))
        existing.inputSchema = tool.inputSchema;
      return;
    }
    if (used.has(name) || tools.length >= MAX_TOOLS) return;
    used.add(name);
    tools.push({ ...tool, name });
    byName.set(name, tools.at(-1));
  };

  const forms = parsed.elements.filter((record) => record.tagName === "form");
  for (const form of forms.slice(0, MAX_FORM_RECORDS)) {
    if (tools.length >= MAX_TOOLS) break;
    const controls = controlRecords(form, parsed);
    const interactive = descendants(form, parsed).filter(
      (record) =>
        ["button", "input", "select", "textarea"].includes(record.tagName) ||
        ACTION_ROLES.has(recordAttribute(record, "role").toLowerCase()),
    );
    const formSignal =
      `${recordMeta(form)} ${recordLabel(form, parsed)} ${recordText(form, parsed)} ${interactive.map((record) => `${recordMeta(record)} ${recordLabel(record, parsed)}`).join(" ")}`.toLowerCase();
    const visibleFormSignal =
      `${recordLabel(form, parsed)} ${recordText(form, parsed)} ${interactive.map((record) => recordLabel(record, parsed)).join(" ")}`.toLowerCase();
    const subject = subjectForRecord(form, parsed, context);
    const searchControls = controls.filter((record) =>
      isSearchControl(record, parsed),
    );
    const travelLocationControls = controls.filter((record) =>
      isTravelLocationControl(record, parsed),
    );
    const searchLike =
      searchControls.length > 0 ||
      /\b(?:search|query|find)\b/.test(formSignal) ||
      (travelLocationControls.length >= 2 &&
        /(?:book|flight|hotel|travel|destination)/.test(formSignal));
    const filterControls = controls.filter((record) =>
      isFilterControl(record, parsed),
    );
    const sortControls = controls.filter((record) =>
      isSortControl(record, parsed),
    );
    const selector = recordSelector(form, parsed);
    if (searchLike) {
      const searchSubject =
        travelLocationControls.length >= 2 ? "options" : subject;
      const searchSchema = schemaForControls(controls, parsed, {
        description: "Values entered into the observed search form.",
      });
      const requiredSearchFields = searchControls
        .map((record) => fieldNameForRecord(record, record.tagName))
        .filter((field) => Object.hasOwn(searchSchema.properties, field));
      if (requiredSearchFields.length > 0)
        searchSchema.required = Array.from(
          new Set([...(searchSchema.required ?? []), ...requiredSearchFields]),
        );
      add(
        potentialTool({
          name: searchToolName(searchSubject),
          description: `Potentially search ${searchSubject} using the visible page form.`,
          inputSchema: searchSchema,
          record: form,
          parsed,
          note: `Observed a search-like form with ${controls.length} typed control${controls.length === 1 ? "" : "s"}.`,
          confidence:
            searchControls.length > 0 || travelLocationControls.length >= 2
              ? 0.84
              : 0.72,
        }),
      );
    }
    if (filterControls.length > 0) {
      add(
        potentialTool({
          name: filterToolName(subject),
          description: `Potentially filter ${subject} using the visible page controls.`,
          inputSchema: schemaForControls(filterControls, parsed, {
            description: "Values from the observed filter controls.",
          }),
          record: form,
          parsed,
          note: `Observed ${filterControls.length} filter control${filterControls.length === 1 ? "" : "s"} in ${selector}.`,
          confidence: 0.8,
        }),
      );
    }
    if (sortControls.length > 0) {
      add(
        potentialTool({
          name: "change_sort",
          description:
            "Potentially change the ordering of the visible results.",
          inputSchema: schemaForControls(sortControls, parsed, {
            description: "Value from the observed sort control.",
          }),
          record: form,
          parsed,
          note: `Observed ${sortControls.length} sort control${sortControls.length === 1 ? "" : "s"} in ${selector}.`,
          confidence: 0.78,
        }),
      );
    }

    let special;
    if (/\b(?:checkout|place\s+order|purchase)\b/.test(visibleFormSignal))
      special = [
        "checkout",
        "Potentially complete the visible checkout form.",
        true,
      ];
    else if (
      /\b(?:contact|feedback|message|enquir|support)\b/.test(visibleFormSignal)
    )
      special = [
        "submit_contact_form",
        "Potentially submit the visible contact form.",
        true,
      ];
    else if (
      /\b(?:sign[ -]?in|log[ -]?in|authenticate)\b/.test(visibleFormSignal)
    )
      special = [
        "sign_in",
        "Potentially sign in using the visible form.",
        true,
      ];
    else if (
      /\b(?:subscribe|newsletter|mailing\s+list)\b/.test(visibleFormSignal)
    )
      special = [
        "subscribe",
        "Potentially subscribe using the visible form.",
        true,
      ];
    else if (!searchLike && /\b(?:book|reserve)\b/.test(visibleFormSignal))
      special = [
        "select_option",
        "Potentially select an option using the visible booking form.",
        true,
      ];
    if (special) {
      add(
        potentialTool({
          name: special[0],
          description: special[1],
          inputSchema: schemaForControls(controls, parsed),
          record: form,
          parsed,
          note: `Observed a ${formDescription(form, parsed)} form with ${controls.length} control${controls.length === 1 ? "" : "s"}.`,
          confidence: 0.8,
          destructive: special[2],
        }),
      );
    }

    if (
      !searchLike &&
      !filterControls.length &&
      !sortControls.length &&
      !special &&
      (controls.length > 0 || interactive.length > 0)
    ) {
      const meaningful = formDescription(form, parsed);
      const generic = "submit_form";
      const namedFields = Object.keys(
        schemaForControls(controls, parsed).properties ?? {},
      );
      add(
        potentialTool({
          name: generic,
          description:
            namedFields.length > 0
              ? `Potentially submit the visible ${meaningful} form using its typed fields.`
              : "Potentially submit the observed page form; field names were not available in the returned markup.",
          inputSchema:
            namedFields.length > 0
              ? schemaForControls(controls, parsed)
              : {
                  type: "object",
                  properties: {
                    fields: {
                      type: "object",
                      description:
                        "Optional values keyed by an observed control label or position.",
                      additionalProperties: { type: "string" },
                    },
                  },
                  additionalProperties: false,
                },
          record: form,
          parsed,
          note:
            namedFields.length > 0
              ? `Observed ${namedFields.length} named form field${namedFields.length === 1 ? "" : "s"}.`
              : `Observed ${controls.length} form control${controls.length === 1 ? "" : "s"}, but no valid named fields were available for a typed schema.`,
          confidence: namedFields.length > 0 ? 0.64 : 0.5,
          destructive: true,
        }),
      );
    }
  }

  const repeated = context.repeatedCards;
  for (const card of context.cards.slice(0, MAX_CARD_RECORDS)) {
    if (tools.length >= MAX_TOOLS) break;
    const signal =
      `${recordMeta(card)} ${recordText(card, parsed)}`.toLowerCase();
    const subject = subjectForRecord(card, parsed, context);
    const cardDescendants = descendants(card, parsed);
    const links = cardDescendants.filter(
      (record) => record.tagName === "a" && recordAttribute(record, "href"),
    );
    const hasEntity =
      Object.keys(card.attrs).some((name) =>
        /^data-(?:product|item|sku|flight|hotel|offer|option|property|id)(?:-|$)/.test(
          name,
        ),
      ) || links.some((record) => itemLinkEvidence(record, card, parsed));
    const hasEntityText =
      /(?:price|sku|product|flight|hotel|room|fare|offer|option|property)/.test(
        signal,
      ) || /[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(?:usd|sgd|eur|gbp)\b/.test(signal);
    if (hasEntity && hasEntityText) {
      const name = detailToolName(subject);
      const isRepeatedCard = repeated.includes(card);
      add(
        potentialTool({
          name,
          description: `Potentially open details for a ${subject === "options" ? "travel option" : subject === "products" ? "product" : "listed item"}.`,
          inputSchema: actionSchema(
            name,
            subject,
            card,
            parsed,
            isRepeatedCard,
          ),
          record: card,
          parsed,
          note: `Observed a ${isRepeatedCard ? "repeated " : ""}${subject === "options" ? "travel option" : subject === "products" ? "product" : "item"} card with a linked or data-backed identifier.`,
          confidence: 0.74,
        }),
      );
    }
  }

  for (const record of interactiveRecords(parsed)) {
    if (tools.length >= MAX_TOOLS) break;
    const tag = record.tagName;
    const type = controlType(record);
    const isControl = ["input", "select", "textarea"].includes(tag);
    const descriptor =
      !isControl ||
      (tag === "input" && ["submit", "button", "image"].includes(type))
        ? actionDescriptor(record, parsed, context, repeated)
        : undefined;
    if (descriptor) add(descriptor);
    if (
      !isControl ||
      ["submit", "button", "image", "reset", "file"].includes(type)
    )
      continue;
    const subject = subjectForRecord(record, parsed, context);
    const field = fieldNameForRecord(record, tag);
    const schema = {
      type: "object",
      properties: { [field]: schemaForControl(record, parsed) },
      required: [field],
      additionalProperties: false,
    };
    if (isSearchControl(record, parsed)) {
      add(
        potentialTool({
          name: searchToolName(subject),
          description: `Potentially search ${subject} using the visible search control.`,
          inputSchema: schema,
          record,
          parsed,
          note: `Observed a search-like ${tag} control named ${field}.`,
          confidence: 0.76,
        }),
      );
    } else if (isSortControl(record, parsed)) {
      add(
        potentialTool({
          name: "change_sort",
          description:
            "Potentially change the ordering of the visible results.",
          inputSchema: schema,
          record,
          parsed,
          note: `Observed a sort-like ${tag} control named ${field}.`,
          confidence: 0.74,
        }),
      );
    } else if (isFilterControl(record, parsed)) {
      add(
        potentialTool({
          name: filterToolName(subject),
          description: `Potentially filter ${subject} using the visible control.`,
          inputSchema: schema,
          record,
          parsed,
          note: `Observed a filter-like ${tag} control named ${field}.`,
          confidence: 0.74,
        }),
      );
    } else if (
      subject === "options" &&
      /(?:depart|return|check[-_ ]?in|check[-_ ]?out|date)/.test(
        `${field} ${recordLabel(record, parsed)}`.toLowerCase(),
      )
    ) {
      add(
        potentialTool({
          name: `set_${field}`,
          description: `Potentially set the visible travel ${field} control.`,
          inputSchema: schema,
          record,
          parsed,
          note: `Observed a travel date or timing control named ${field}.`,
          confidence: 0.66,
        }),
      );
    }
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
    ...inferredToolsFromHtml(html, used, targetUrl),
    // Some challenge pages contain permissive or slightly malformed HTML
    // (for example whitespace in a closing tag). The bounded sanitized
    // snapshot normalizes those tags while preserving the actionable form
    // evidence, so retry inference against it before reporting no tools.
    ...inferredToolsFromHtml(previewHtml, used, targetUrl),
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
