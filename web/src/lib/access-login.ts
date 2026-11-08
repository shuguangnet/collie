import { mounted } from "./base-path";
import { asJsonBoolean, asJsonString, parseJsonObject } from "./json";

type AccessBody = { label: string; password: string } | { guide: string };

/** Issuance requests never carry a password outside their POST body or follow redirects. */
export class AccessLoginError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super("Sign-in failed");
    this.status = status;
    this.code = code;
  }
}

async function request(path: string, body?: AccessBody, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    redirect: "manual",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    signal: signal ?? AbortSignal.timeout(10_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(mounted(path), init);
  if (!res.ok) {
    const value = parseJsonObject(await res.text());
    throw new AccessLoginError(res.status, asJsonString(value?.code) ?? "unavailable");
  }
  return res;
}

export async function accessPasswordConfigured(signal?: AbortSignal): Promise<boolean> {
  const res = await request("/api/auth/status", undefined, signal);
  const value = parseJsonObject(await res.text());
  const configured = asJsonBoolean(value?.configured);
  if (configured === undefined) throw new AccessLoginError(503, "unavailable");
  return configured;
}

export async function exchangeAccess(path: "/api/auth/login" | "/api/auth/open", body: AccessBody): Promise<string> {
  const res = await request(path, body);
  const value = parseJsonObject(await res.text());
  const token = asJsonString(value?.token);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessLoginError(503, "unavailable");
  return token;
}
