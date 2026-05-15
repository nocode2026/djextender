export async function getSidecarErrorDetail(response: Response): Promise<string> {
  const fallback = response.statusText || "Unknown error";

  try {
    const body = (await response.clone().json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail;
    }
  } catch {
    // Ignore JSON parse errors and fallback below.
  }

  try {
    const text = (await response.clone().text()).trim();
    if (text) {
      return text;
    }
  } catch {
    // Ignore text read errors and use fallback.
  }

  return fallback;
}

export async function throwSidecarHttpError(response: Response, operationName: string): Promise<never> {
  const detail = await getSidecarErrorDetail(response);
  throw new Error(`${operationName} failed (${response.status}): ${detail}`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
