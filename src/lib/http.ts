import { USER_AGENT } from "./config";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with descriptive User-Agent, JSON parsing, and exponential backoff on
 * 429/5xx. All upstream API calls go through this.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { retries?: number } = {},
): Promise<T> {
  const { retries = 3, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        ...rest,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(rest.body ? { "content-type": "application/json" } : {}),
          ...rest.headers,
        },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, url, await res.text());
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url, await res.text());
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) {
        throw err;
      }
      lastErr = err;
    }
  }
  throw lastErr;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
