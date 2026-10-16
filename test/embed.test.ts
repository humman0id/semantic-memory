import { describe, expect, it } from "vitest";

import {
  createOllamaEmbedder,
  probeEmbedder,
  type Embedder,
} from "../src/embed.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("createOllamaEmbedder", () => {
  it("POSTs to /api/embed with the right body and returns the first embedding", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = inputUrl(input);
      capturedInit = init;
      return jsonResponse({ embeddings: [[0.1, 0.2]] });
    };

    const embedder = createOllamaEmbedder({
      baseUrl: "http://embed.test",
      model: "test-model",
      fetch: fakeFetch,
    });

    const result = await embedder.embed("hello world");

    expect(capturedUrl).toBe("http://embed.test/api/embed");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "test-model",
      input: "hello world",
    });
    expect(new Headers(capturedInit?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(result).toEqual([0.1, 0.2]);
  });

  it("strips a trailing slash from baseUrl", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = inputUrl(input);
      return jsonResponse({ embeddings: [[1, 2, 3]] });
    };

    const embedder = createOllamaEmbedder({
      baseUrl: "http://embed.test/",
      fetch: fakeFetch,
    });

    await embedder.embed("x");

    expect(capturedUrl).toBe("http://embed.test/api/embed");
  });

  it("rejects when the response is not ok", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("oops", { status: 503 });

    const embedder = createOllamaEmbedder({
      baseUrl: "http://embed.test",
      fetch: fakeFetch,
    });

    await expect(embedder.embed("x")).rejects.toThrow("embed failed: HTTP 503");
  });

  it("rejects on malformed JSON", async () => {
    const fakeFetch: typeof fetch = async () => new Response("not json");

    const embedder = createOllamaEmbedder({
      baseUrl: "http://embed.test",
      fetch: fakeFetch,
    });

    await expect(embedder.embed("x")).rejects.toThrow();
  });

  it("rejects when embeddings[0] is not a non-empty array of finite numbers", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({ embeddings: [[0.1, Number.NaN]] });

    const embedder = createOllamaEmbedder({
      baseUrl: "http://embed.test",
      fetch: fakeFetch,
    });

    await expect(embedder.embed("x")).rejects.toThrow("embed failed: invalid response");
  });
});

describe("probeEmbedder", () => {
  it("returns available true when the embedder resolves", async () => {
    const ok: Embedder = { embed: async () => [0.1, 0.2] };
    await expect(probeEmbedder(ok)).resolves.toEqual({ available: true });
  });

  it("returns available false when the embedder throws", async () => {
    const broken: Embedder = {
      embed: async () => {
        throw new Error("boom");
      },
    };
    await expect(probeEmbedder(broken)).resolves.toEqual({
      available: false,
      error: "boom",
    });
  });
});
