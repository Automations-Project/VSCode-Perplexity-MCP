declare module "express" {
  export interface Request {
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
    method: string;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface Response {
    setHeader(name: string, value: string): this;
    status(code: number): this;
    json(body: unknown): this;
    write(chunk: string): boolean;
    end(chunk?: string): this;
    on(event: string, listener: (...args: any[]) => void): this;
    flushHeaders?: () => void;
  }

  export type NextFunction = (error?: unknown) => void;

  export interface Express {
    use(...args: any[]): any;
    all(path: string, ...handlers: any[]): any;
    get(path: string, ...handlers: any[]): any;
    post(path: string, ...handlers: any[]): any;
  }

  interface ExpressFactory {
    (): Express;
    json(options?: unknown): any;
  }

  const express: ExpressFactory;
  export default express;
}
