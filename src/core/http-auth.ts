import { Buffer } from "node:buffer";

export interface PreparedHttpRequest {
  url: string;
  init: RequestInit;
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function prepareHttpRequest(input: string | URL, init: RequestInit = {}): PreparedHttpRequest {
  const url = new URL(input.toString());
  const headers = new Headers(init.headers);
  const hasEmbeddedCredentials = url.username !== "" || url.password !== "";

  if (hasEmbeddedCredentials && !headers.has("authorization")) {
    const username = decodeCredential(url.username);
    const password = decodeCredential(url.password);
    const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    headers.set("authorization", `Basic ${token}`);
  }

  url.username = "";
  url.password = "";
  return {
    url: url.toString(),
    init: { ...init, headers },
  };
}

export function sanitizeHttpUrl(input: string | URL): string {
  return prepareHttpRequest(input).url;
}
