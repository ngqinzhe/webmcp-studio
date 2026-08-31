import type { JSONSchema, JsonValue } from "../../core/types";
import { TargetRuntime, type TargetToolRegistration } from "./target-runtime";

interface TravelOption {
  id: string;
  airline: string;
  origin: string;
  destination: string;
  date: string;
  departure: string;
  arrival: string;
  duration: string;
  cabin: "economy" | "premium";
  price: number;
  stops: number;
}

const options: TravelOption[] = [
  {
    id: "ns-sin-tyo-201",
    airline: "Northstar Air",
    origin: "Singapore",
    destination: "Tokyo",
    date: "2026-10-15",
    departure: "08:10",
    arrival: "15:15",
    duration: "7h 05m",
    cabin: "economy",
    price: 420,
    stops: 0,
  },
  {
    id: "ns-sin-tyo-204",
    airline: "Skyline Connect",
    origin: "Singapore",
    destination: "Tokyo",
    date: "2026-10-15",
    departure: "09:20",
    arrival: "17:00",
    duration: "6h 40m",
    cabin: "economy",
    price: 390,
    stops: 0,
  },
  {
    id: "ns-sin-tyo-512",
    airline: "Northstar Air",
    origin: "Singapore",
    destination: "Tokyo",
    date: "2026-10-15",
    departure: "22:15",
    arrival: "06:00",
    duration: "7h 45m",
    cabin: "premium",
    price: 760,
    stops: 0,
  },
  {
    id: "ns-sin-mel-318",
    airline: "Skyline Connect",
    origin: "Singapore",
    destination: "Melbourne",
    date: "2026-10-16",
    departure: "09:15",
    arrival: "19:35",
    duration: "7h 20m",
    cabin: "economy",
    price: 385,
    stops: 0,
  },
  {
    id: "ns-sin-seoul-442",
    airline: "Northstar Air",
    origin: "Singapore",
    destination: "Seoul",
    date: "2026-10-16",
    departure: "13:30",
    arrival: "21:05",
    duration: "6h 35m",
    cabin: "economy",
    price: 460,
    stops: 0,
  },
];

const searchSchema: JSONSchema = {
  type: "object",
  properties: {
    origin: { type: "string", minLength: 1, maxLength: 40 },
    destination: { type: "string", minLength: 1, maxLength: 40 },
  },
  required: ["origin", "destination"],
  additionalProperties: false,
};

const filterSchema: JSONSchema = {
  type: "object",
  properties: {
    optionIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      maxItems: 20,
    },
    maxPrice: { type: "number", minimum: 0, maximum: 10000 },
    cabin: { type: "string", enum: ["economy", "premium"] },
  },
  required: ["maxPrice"],
  additionalProperties: false,
};

const optionSchema: JSONSchema = {
  type: "object",
  properties: { optionId: { type: "string", minLength: 1, maxLength: 100 } },
  required: ["optionId"],
  additionalProperties: false,
};

const emptySchema: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArg(args: unknown, key: string): string {
  const value = record(args)[key];
  return typeof value === "string" ? value : "";
}

function numberArg(args: unknown, key: string): number {
  const value = record(args)[key];
  return typeof value === "number" ? value : 0;
}

function optionValue(option: TravelOption): JsonValue {
  return { ...option };
}

function optionById(id: string): TravelOption {
  const option = options.find((candidate) => candidate.id === id);
  if (!option) throw new Error(`Travel option ${id} was not found.`);
  return option;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Travel target is missing ${selector}.`);
  return element;
}

const list = requiredElement<HTMLElement>("#flights");
const status = requiredElement<HTMLElement>("#status");
const resultCount = requiredElement<HTMLElement>("#result-count");
const tripStatus = requiredElement<HTMLElement>("#trip-status");
const details = requiredElement<HTMLElement>("#details");
const detailsRoute = requiredElement<HTMLElement>("#details-route");
const detailsDescription = requiredElement<HTMLElement>("#details-description");
const detailsPrice = requiredElement<HTMLElement>("#details-price");
let visibleIds = new Set(options.map((option) => option.id));
let selectedOption: string | null = null;

function setStatus(message: string, kind: "success" | "error" | "" = "") {
  status.textContent = message;
  status.className = `status${kind ? ` is-${kind}` : ""}`;
}

function render(): void {
  const visible = options.filter((option) => visibleIds.has(option.id));
  list.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No routes match this request.";
    list.append(empty);
  } else {
    for (const option of visible) {
      const card = document.createElement("article");
      card.className = `flight${selectedOption === option.id ? " is-selected" : ""}`;

      const main = document.createElement("div");
      const airline = document.createElement("div");
      airline.className = "flight-airline";
      airline.textContent = option.airline;
      const route = document.createElement("div");
      route.className = "route";
      route.append(option.origin, " ");
      const arrow = document.createElement("span");
      arrow.className = "route-arrow";
      arrow.textContent = "→";
      route.append(arrow, ` ${option.destination}`);
      const meta = document.createElement("div");
      meta.className = "flight-meta";
      meta.textContent = `${option.date} · ${option.departure}–${option.arrival} · ${option.duration} · ${option.cabin} · ${option.stops === 0 ? "nonstop" : `${option.stops} stop`}`;
      main.append(airline, route, meta);

      const side = document.createElement("div");
      side.className = "flight-side";
      const price = document.createElement("strong");
      price.className = "flight-price";
      price.textContent = `$${option.price}`;
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = "Select route";
      select.addEventListener("click", () => {
        void runtime.invoke("select_option", { optionId: option.id });
      });
      side.append(price, select);
      card.append(main, side);
      card.addEventListener("dblclick", () => {
        void runtime.invoke("get_details", { optionId: option.id });
      });
      list.append(card);
    }
  }

  resultCount.textContent = `${visible.length} ${visible.length === 1 ? "route" : "routes"}`;
  tripStatus.textContent = selectedOption
    ? `${optionById(selectedOption).id} selected`
    : "No flight";
  const selected = selectedOption ? optionById(selectedOption) : null;
  details.hidden = selected === null;
  if (selected) {
    detailsRoute.textContent = `${selected.origin} → ${selected.destination}`;
    detailsDescription.textContent = `${selected.airline} · ${selected.date} · ${selected.departure}–${selected.arrival} · ${selected.duration} · ${selected.cabin}`;
    detailsPrice.textContent = `$${selected.price}`;
  }
}

function optionsFor(ids: readonly string[]): TravelOption[] {
  return ids.flatMap((id) => {
    const option = options.find((candidate) => candidate.id === id);
    return option ? [option] : [];
  });
}

const tools: TargetToolRegistration[] = [
  {
    name: "search_options",
    description:
      "Search the controlled Skyline Travel route catalog by origin and destination.",
    inputSchema: searchSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#origin, #destination",
        note: "Origin and destination fields drive the route search.",
      },
    ],
    execute: (args) => {
      const origin = stringArg(args, "origin").trim();
      const destination = stringArg(args, "destination").trim();
      const originQuery = origin.toLowerCase();
      const destinationQuery = destination.toLowerCase();
      const matches = options.filter(
        (option) =>
          option.origin.toLowerCase().includes(originQuery) &&
          option.destination.toLowerCase().includes(destinationQuery),
      );
      visibleIds = new Set(matches.map((option) => option.id));
      selectedOption = null;
      render();
      setStatus(
        `Found ${matches.length} route${matches.length === 1 ? "" : "s"} from ${origin} to ${destination}.`,
        "success",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        origin,
        destination,
        optionIds: matches.map((option) => option.id),
        options: matches.map(optionValue),
        count: matches.length,
        warnings: [],
      };
    },
  },
  {
    name: "filter_options",
    description:
      "Filter searched routes by fare and cabin, returning the best matching options.",
    inputSchema: filterSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#max-price, #flights",
        note: "Fare control and route result cards expose the filter outcome.",
      },
    ],
    execute: (args) => {
      const input = record(args);
      const maxPrice = numberArg(input, "maxPrice");
      const requestedIds = Array.isArray(input.optionIds)
        ? input.optionIds.filter((id): id is string => typeof id === "string")
        : Array.from(visibleIds);
      const cabin =
        input.cabin === "economy" || input.cabin === "premium"
          ? input.cabin
          : undefined;
      const matches = optionsFor(requestedIds)
        .filter(
          (option) =>
            option.price <= maxPrice &&
            (cabin === undefined || option.cabin === cabin),
        )
        .sort(
          (left, right) => left.price - right.price || left.stops - right.stops,
        );
      visibleIds = new Set(matches.map((option) => option.id));
      render();
      setStatus(
        matches.length
          ? `Best matching route: ${matches[0]!.origin} to ${matches[0]!.destination} for $${matches[0]!.price}.`
          : `No matching route is under $${maxPrice}.`,
        matches.length ? "success" : "",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        maxPrice,
        optionIds: matches.map((option) => option.id),
        bestOptionId: matches[0]?.id ?? null,
        options: matches.map(optionValue),
        count: matches.length,
        warnings: [],
      };
    },
  },
  {
    name: "get_details",
    description:
      "Read details for one route in the controlled itinerary catalog.",
    inputSchema: optionSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "action",
        selector: "#flights .flight",
        note: "A route card opens the selected itinerary details panel.",
      },
    ],
    execute: (args) => {
      const option = optionById(stringArg(args, "optionId"));
      selectedOption = option.id;
      render();
      setStatus(
        `Showing details for ${option.origin} to ${option.destination}.`,
        "success",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        optionId: option.id,
        option: optionValue(option),
        warnings: [],
      };
    },
  },
  {
    name: "select_option",
    description:
      "Select one route for the current trip; this demo does not book or purchase a ticket.",
    inputSchema: optionSchema,
    annotations: { destructiveHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "action",
        selector: "#flights button",
        note: "Select route marks the itinerary and updates the trip badge.",
      },
    ],
    execute: (args) => {
      const option = optionById(stringArg(args, "optionId"));
      selectedOption = option.id;
      render();
      setStatus(
        `Selected ${option.origin} to ${option.destination}. No booking was made.`,
        "success",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        optionId: option.id,
        selected: optionValue(option),
        bookingCreated: false,
        warnings: [],
      };
    },
  },
  {
    name: "view_itinerary",
    description: "Read the route currently selected for the trip.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#trip-status, #details",
        note: "The selected itinerary is visible in the trip badge and details panel.",
      },
    ],
    execute: () => ({
      ok: true,
      status: "completed",
      stateChanged: false,
      navigationOccurred: false,
      selected: selectedOption ? optionValue(optionById(selectedOption)) : null,
      warnings: [],
    }),
  },
];

let runtime: TargetRuntime = new TargetRuntime({
  target: { id: "travel", name: "Skyline Travel", url: window.location.href },
});

render();
runtime
  .addTool(tools[0]!)
  .addTool(tools[1]!)
  .addTool(tools[2]!)
  .addTool(tools[3]!)
  .addTool(tools[4]!);
const nativeStatus = requiredElement<HTMLElement>("#native-status");
const renderNativeStatus = (): void => {
  nativeStatus.textContent =
    runtime.mode === "native"
      ? "Live WebMCP · primitives registered"
      : "Preview only · native registerTool unavailable";
  nativeStatus.classList.toggle("is-live", runtime.mode === "native");
};
renderNativeStatus();
void runtime.start().then(renderNativeStatus);

requiredElement<HTMLFormElement>("#search-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    const origin = requiredElement<HTMLInputElement>("#origin").value;
    const destination = requiredElement<HTMLInputElement>("#destination").value;
    const maxPrice = Number(
      requiredElement<HTMLInputElement>("#max-price").value,
    );
    void runtime
      .invoke("search_options", { origin, destination })
      .then((result) => {
        const ids = record(result).optionIds;
        return runtime.invoke("filter_options", {
          optionIds: Array.isArray(ids) ? ids : [],
          maxPrice,
        });
      })
      .catch((error: unknown) => {
        setStatus(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
  },
);
