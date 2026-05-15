import { describe, expect, it, vi } from "vitest";

import { getSidecarErrorDetail, sleep, throwSidecarHttpError } from "./sidecarHttp";

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, statusText: string, body: string): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "content-type": "text/plain" },
  });
}

describe("sidecarHttp helpers", () => {
  it("reads JSON detail when present", async () => {
    const response = jsonResponse(500, "Internal Server Error", { detail: "Boom from sidecar" });

    const detail = await getSidecarErrorDetail(response);

    expect(detail).toBe("Boom from sidecar");
  });

  it("falls back to response text when JSON detail is missing", async () => {
    const response = textResponse(400, "Bad Request", "Plain text error");

    const detail = await getSidecarErrorDetail(response);

    expect(detail).toBe("Plain text error");
  });

  it("falls back to status text when body parsing fails", async () => {
    const response = new Response(null, { status: 503, statusText: "Service Unavailable" });

    const detail = await getSidecarErrorDetail(response);

    expect(detail).toBe("Service Unavailable");
  });

  it("throws formatted sidecar http error", async () => {
    const response = jsonResponse(422, "Unprocessable Entity", { detail: "Invalid payload" });

    await expect(throwSidecarHttpError(response, "Sidecar analysis")).rejects.toThrow(
      "Sidecar analysis failed (422): Invalid payload",
    );
  });

  it("sleep resolves after timer advances", async () => {
    vi.useFakeTimers();
    const promise = sleep(300);

    await vi.advanceTimersByTimeAsync(299);
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toBe(true);

    vi.useRealTimers();
  });
});
