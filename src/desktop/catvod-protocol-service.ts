import type { Net, Protocol } from "electron";
import { CATVOD_PROTOCOL_SCHEME, restoreCatVodTarget } from "../core/catvod/catvod-url-rewriter.ts";

export class CatVodProtocolService {
  private readonly baseUrl: () => string | undefined;
  private readonly fetchImpl: Net["fetch"];

  constructor(baseUrl: () => string | undefined, fetchImpl: Net["fetch"]) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  register(protocol: Protocol): void {
    protocol.handle(CATVOD_PROTOCOL_SCHEME, async (request) => {
      const baseUrl = this.baseUrl();
      if (!baseUrl) return new Response("CatVod service is not running", { status: 503 });
      let target: string;
      try {
        target = restoreCatVodTarget(request.url, baseUrl);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
      }

      const headers = new Headers(request.headers);
      headers.delete("origin");
      const method = request.method.toUpperCase();
      return this.fetchImpl(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
        redirect: "follow",
        bypassCustomProtocolHandlers: true,
      });
    });
  }
}
