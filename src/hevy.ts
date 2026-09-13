/**
 * Thin fetch wrapper around the Hevy public API (https://api.hevyapp.com/docs/).
 * Every request carries the `api-key` header. Non-2xx responses become
 * HevyApiError so tools can surface the status and Hevy's error text.
 */

const BASE_URL = "https://api.hevyapp.com/v1";

export class HevyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string
  ) {
    super(`Hevy API ${method} ${path} returned ${status}: ${body || "(empty body)"}`);
    this.name = "HevyApiError";
  }
}

export type Query = Record<string, string | number | undefined>;

export interface HevyClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
}

export function createHevyClient(apiKey: string): HevyClient {
  async function request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      "api-key": apiKey,
      accept: "application/json"
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok) throw new HevyApiError(res.status, text, method, path);
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
    put: (path, body) => request("PUT", path, { body })
  };
}

/** Encode a user supplied id for use as a path segment. */
export function seg(id: string): string {
  return encodeURIComponent(id);
}
