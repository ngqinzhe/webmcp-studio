declare module "jsdom" {
  interface JSDOMOptions {
    url?: string;
  }

  export class JSDOM {
    readonly window: Window & typeof globalThis;

    constructor(html?: string, options?: JSDOMOptions);
  }
}
