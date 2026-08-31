import type { JSONSchema, JsonValue } from "../../core/types";
import { TargetRuntime, type TargetToolRegistration } from "./target-runtime";

interface Product {
  id: string;
  name: string;
  category: "keyboards" | "mice" | "lighting" | "audio";
  price: number;
  description: string;
}

const products: Product[] = [
  {
    id: "atlas-keyboard",
    name: "Atlas Mechanical Keyboard",
    category: "keyboards",
    price: 129,
    description: "Quiet tactile switches with a compact aluminum frame.",
  },
  {
    id: "orbit-mouse",
    name: "Orbit Precision Mouse",
    category: "mice",
    price: 79,
    description: "A comfortable wireless mouse for long working sessions.",
  },
  {
    id: "northstar-desk-lamp",
    name: "Northstar Desk Lamp",
    category: "lighting",
    price: 96,
    description: "Warm, dimmable light with a weighted recycled-metal base.",
  },
  {
    id: "summit-headset",
    name: "Summit Headset",
    category: "audio",
    price: 189,
    description: "Clear calls and a soft fit for focused afternoons.",
  },
];

const searchSchema: JSONSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1, maxLength: 80 } },
  required: ["query"],
  additionalProperties: false,
};

const filterSchema: JSONSchema = {
  type: "object",
  properties: {
    maxPrice: { type: "number", minimum: 0, maximum: 10000 },
    category: {
      type: "string",
      enum: ["all", "keyboards", "mice", "lighting", "audio"],
    },
  },
  required: ["maxPrice"],
  additionalProperties: false,
};

const productSchema: JSONSchema = {
  type: "object",
  properties: { productId: { type: "string", minLength: 1, maxLength: 100 } },
  required: ["productId"],
  additionalProperties: false,
};

const addToCartSchema: JSONSchema = {
  type: "object",
  properties: {
    productId: { type: "string", minLength: 1, maxLength: 100 },
    quantity: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["productId", "quantity"],
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

function productValue(product: Product): JsonValue {
  return { ...product };
}

function productById(id: string): Product {
  const product = products.find((candidate) => candidate.id === id);
  if (!product) throw new Error(`Product ${id} was not found.`);
  return product;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Commerce target is missing ${selector}.`);
  return element;
}

const list = requiredElement<HTMLElement>("#products");
const status = requiredElement<HTMLElement>("#status");
const resultCount = requiredElement<HTMLElement>("#result-count");
const cartCount = requiredElement<HTMLElement>("#cart-count");
const details = requiredElement<HTMLElement>("#details");
const detailsName = requiredElement<HTMLElement>("#details-name");
const detailsDescription = requiredElement<HTMLElement>("#details-description");
const detailsPrice = requiredElement<HTMLElement>("#details-price");
let visibleIds = new Set(products.map((product) => product.id));
let selectedProduct: string | null = null;
const cart = new Map<string, number>();

function setStatus(message: string, kind: "success" | "error" | "" = "") {
  status.textContent = message;
  status.className = `status${kind ? ` is-${kind}` : ""}`;
}

function render(): void {
  const visible = products.filter((product) => visibleIds.has(product.id));
  list.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No products match this request.";
    list.append(empty);
  } else {
    for (const product of visible) {
      const card = document.createElement("article");
      card.className = `product${selectedProduct === product.id ? " is-selected" : ""}`;
      const top = document.createElement("div");
      top.className = "product-top";
      const category = document.createElement("span");
      category.className = "product-category";
      category.textContent = product.category;
      const price = document.createElement("strong");
      price.className = "product-price";
      price.textContent = `$${product.price}`;
      top.append(category, price);
      const title = document.createElement("h3");
      title.textContent = product.name;
      const description = document.createElement("p");
      description.textContent = product.description;
      const actions = document.createElement("div");
      actions.className = "product-actions";
      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "Details";
      view.addEventListener("click", () => {
        void runtime.invoke("get_product", { productId: product.id });
      });
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "Add to cart";
      add.addEventListener("click", () => {
        void runtime.invoke("add_to_cart", {
          productId: product.id,
          quantity: 1,
        });
      });
      actions.append(view, add);
      card.append(top, title, description, actions);
      list.append(card);
    }
  }
  resultCount.textContent = `${visible.length} ${visible.length === 1 ? "product" : "products"}`;
  const quantity = Array.from(cart.values()).reduce(
    (sum, value) => sum + value,
    0,
  );
  cartCount.textContent = String(quantity);
  const selected = selectedProduct
    ? products.find((product) => product.id === selectedProduct)
    : undefined;
  details.hidden = selected === undefined;
  if (selected) {
    detailsName.textContent = selected.name;
    detailsDescription.textContent = selected.description;
    detailsPrice.textContent = `$${selected.price}`;
  }
}

const tools: TargetToolRegistration[] = [
  {
    name: "search_products",
    description: "Find products in the Northstar Supply catalog by keyword.",
    inputSchema: searchSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#query",
        note: "Product requirements field drives the catalog search.",
      },
    ],
    execute: (args) => {
      const query = stringArg(args, "query").trim().toLowerCase();
      visibleIds = new Set(
        products
          .filter((product) =>
            [product.name, product.category, product.description].some(
              (value) => value.toLowerCase().includes(query),
            ),
          )
          .map((product) => product.id),
      );
      selectedProduct = null;
      render();
      setStatus(
        `Found ${visibleIds.size} product${visibleIds.size === 1 ? "" : "s"} for “${query}”.`,
        "success",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        query,
        productIds: products
          .filter((product) => visibleIds.has(product.id))
          .map((product) => product.id),
        products: products
          .filter((product) => visibleIds.has(product.id))
          .map(productValue),
        warnings: [],
      };
    },
  },
  {
    name: "filter_products",
    description: "Keep visible products at or below a maximum price.",
    inputSchema: filterSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#max-price, #products",
        note: "Maximum price control and product cards show the filter result.",
      },
    ],
    execute: (args) => {
      const category = stringArg(args, "category");
      const maxPrice = numberArg(args, "maxPrice");
      visibleIds = new Set(
        products
          .filter(
            (product) =>
              visibleIds.has(product.id) &&
              product.price <= maxPrice &&
              (category === "" ||
                category === "all" ||
                product.category === category),
          )
          .map((product) => product.id),
      );
      render();
      setStatus(`Filtered products to $${maxPrice} or less.`, "success");
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        maxPrice,
        productIds: products
          .filter((product) => visibleIds.has(product.id))
          .map((product) => product.id),
        products: products
          .filter((product) => visibleIds.has(product.id))
          .map(productValue),
        warnings: [],
      };
    },
  },
  {
    name: "get_product",
    description: "Read the details for one catalog product.",
    inputSchema: productSchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "action",
        selector: "#products .product button:first-child",
        note: "Product card Details action opens the selected product panel.",
      },
    ],
    execute: (args) => {
      const product = productById(stringArg(args, "productId"));
      selectedProduct = product.id;
      render();
      setStatus(`Viewing ${product.name}.`, "success");
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        productId: product.id,
        product: productValue(product),
        warnings: [],
      };
    },
  },
  {
    name: "add_to_cart",
    description:
      "Add a catalog product and quantity to the in-page cart; no checkout is performed.",
    inputSchema: addToCartSchema,
    annotations: { destructiveHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "action",
        selector: "#products .product button:last-child, #cart-count",
        note: "Add to cart updates the visible cart counter.",
      },
    ],
    execute: (args) => {
      const product = productById(stringArg(args, "productId"));
      const quantity = numberArg(args, "quantity");
      selectedProduct = product.id;
      cart.set(product.id, (cart.get(product.id) ?? 0) + quantity);
      render();
      setStatus(
        `Added ${quantity} ${product.name}${quantity === 1 ? "" : "s"} to the cart.`,
        "success",
      );
      return {
        ok: true,
        status: "completed",
        stateChanged: true,
        navigationOccurred: false,
        productId: product.id,
        product: productValue(product),
        quantity: cart.get(product.id) ?? quantity,
        cartItems: Array.from(cart, ([productId, count]) => ({
          productId,
          quantity: count,
        })),
        totalItems: Array.from(cart.values()).reduce(
          (sum, value) => sum + value,
          0,
        ),
        warnings: [],
      };
    },
  },
  {
    name: "view_cart",
    description: "Read the products currently in the Northstar Supply cart.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
    source: "webmcp",
    confidence: 1,
    evidence: [
      {
        type: "dom",
        selector: "#cart-count",
        note: "Cart counter exposes the current in-page cart state.",
      },
    ],
    execute: () => ({
      ok: true,
      status: "completed",
      stateChanged: false,
      navigationOccurred: false,
      items: Array.from(cart, ([productId, quantity]) => ({
        productId,
        quantity,
      })),
      totalItems: Array.from(cart.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
      warnings: [],
    }),
  },
];

let runtime = new TargetRuntime({
  target: {
    id: "commerce",
    name: "Northstar Supply",
    url: window.location.href,
  },
});
runtime
  .addTool(tools[0]!)
  .addTool(tools[1]!)
  .addTool(tools[2]!)
  .addTool(tools[3]!)
  .addTool(tools[4]!);
render();

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
    const query = requiredElement<HTMLInputElement>("#query").value;
    const maxPrice = Number(
      requiredElement<HTMLInputElement>("#max-price").value,
    );
    void runtime
      .invoke("search_products", { query })
      .then(() => runtime.invoke("filter_products", { maxPrice }))
      .catch((error: unknown) => {
        setStatus(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
  },
);
