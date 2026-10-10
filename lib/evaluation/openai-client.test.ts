import { describe, expect, it } from "vitest";

import type { ClientOptions } from "openai";

import { CHALLENGES } from "../challenges/data";
import { DEFAULT_TIMEOUT_MS, TEMPERATURE, evaluateSubmission } from "./evaluator";
import { EvaluatorConfigError, createOpenAIClient } from "./openai-client";
import type { Submission } from "./schema";
import type { EvaluatorRequestBody } from "./types";

const challenge = CHALLENGES[0];
const submission: Submission = {
  walletPublicKey: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
  challengeId: 1,
  explanation: "A PDA is derived from seeds and the program id, so no wallet can sign for it.".padEnd(120, "."),
  code: "fn main() {}",
};

const CANNED_GRADES = {
  criteria: challenge.rubric.map((criterion) => ({
    id: criterion.id,
    points: criterion.weight,
    comment: `graded ${criterion.id}`,
  })),
  strengths: ["complete"],
  weaknesses: [],
  feedback: "Excellent coverage.",
};

function completionBody(): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "qwen3-coder-plus",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(CANNED_GRADES) } }],
  });
}

type Captured = { url: string; body: string; authorization: string | null; signalSeen: boolean };

/**
 * A fetch stand-in, so these tests exercise the real SDK request/response path
 * (URL building, JSON parsing, error raising) without any network. This is the
 * only way to verify the adapter in `openai-client.ts` beyond type checking.
 */
function captureFetch(capture: Captured, responder: () => Response): ClientOptions["fetch"] {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    capture.body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    capture.authorization = headers.get("authorization");
    capture.signalSeen = init?.signal !== undefined;
    return responder();
  };
}

function newCapture(): Captured {
  return { url: "", body: "", authorization: null, signalSeen: false };
}

/**
 * A fetch that never produces a response but does honour `init.signal`, the way
 * real fetch does. Used to prove the SDK's `timeout` option aborts the request
 * rather than hanging until our own deadline fires.
 */
function hangingFetch(capture: Captured): ClientOptions["fetch"] {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.url = typeof input === "string" ? input : String(input);
    capture.signalSeen = init?.signal !== undefined;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      const abort = () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  };
}

const config = {
  apiKey: "test-key",
  baseURL: "https://gateway.invalid/v1",
  model: "qwen3-coder-plus",
};

describe("createOpenAIClient", () => {
  it("exposes the model id that becomes EvaluationResult.provider", () => {
    const client = createOpenAIClient({ ...config, fetch: captureFetch(newCapture(), () => new Response("", { status: 500 })) });
    expect(client.model).toBe("qwen3-coder-plus");
    expect(typeof client.create).toBe("function");
  });

  it("refuses an empty config instead of letting the SDK fail mid-request", () => {
    for (const bad of [{ ...config, apiKey: "  " }, { ...config, baseURL: "" }, { ...config, model: "" }]) {
      expect(() => createOpenAIClient({ ...bad, fetch: captureFetch(newCapture(), () => new Response("", { status: 500 })) })).toThrow(
        EvaluatorConfigError,
      );
    }
  });

  it("posts JSON-mode chat completions to the configured endpoint", async () => {
    const capture = newCapture();
    const client = createOpenAIClient({ ...config, fetch: captureFetch(capture, () => new Response(completionBody(), { status: 200, headers: { "content-type": "application/json" } })) });

    const body: EvaluatorRequestBody = {
      model: client.model,
      messages: [
        { role: "system", content: "grade this" },
        { role: "user", content: "text" },
      ],
      temperature: TEMPERATURE,
      response_format: { type: "json_object" },
    };
    const response = await client.create(body);

    expect(capture.url).toBe("https://gateway.invalid/v1/chat/completions");
    expect(capture.authorization).toBe("Bearer test-key");
    // The SDK passes an AbortSignal, which is how its own `timeout` option can
    // cancel a hung request; our evaluator races the same deadline.
    expect(capture.signalSeen).toBe(true);
    const sent = JSON.parse(capture.body) as Record<string, unknown>;
    expect(sent.model).toBe("qwen3-coder-plus");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.temperature).toBe(TEMPERATURE);
    expect(sent.stream).toBeUndefined();
    expect(response.choices[0]?.message.content).toContain("pda_derivation");
  });

  it("raises the SDK's own typed errors, which the evaluator classifies", async () => {
    const capture = newCapture();
    const client = createOpenAIClient({
      ...config,
      fetch: captureFetch(capture, () => new Response('{"error":{"message":"overloaded","type":"server_error"}}', { status: 503, headers: { "content-type": "application/json" } })),
    });
    await expect(
      client.create({
        model: client.model,
        messages: [{ role: "user", content: "x" }],
        temperature: TEMPERATURE,
        response_format: { type: "json_object" },
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("lets the SDK's own timeout abort a hung request, which the evaluator reads as AI_TIMEOUT", async () => {
    const capture = newCapture();
    const client = createOpenAIClient({
      ...config,
      // Far shorter than the evaluator's deadline, so the SDK must be the thing
      // that gives up. Real fetch rejects when its signal aborts; so does this.
      timeoutMs: 10,
      fetch: hangingFetch(capture),
    });
    const outcome = await evaluateSubmission(challenge, submission, client, { timeoutMs: 5_000, retryDelayMs: 1 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("AI_TIMEOUT");
      expect(outcome.error.retryable).toBe(true);
    }
    expect(capture.signalSeen).toBe(true);
  });

  it("drives a full evaluation through the real SDK with a stub transport", async () => {
    const capture = newCapture();
    const client = createOpenAIClient({ ...config, fetch: captureFetch(capture, () => new Response(completionBody(), { status: 200, headers: { "content-type": "application/json" } })) });
    const outcome = await evaluateSubmission(challenge, submission, client, { timeoutMs: DEFAULT_TIMEOUT_MS, retryDelayMs: 1 });

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(100);
      expect(outcome.data.passed).toBe(true);
      expect(outcome.data.provider).toBe("qwen3-coder-plus");
    }
    expect(capture.url).toBe("https://gateway.invalid/v1/chat/completions");
  });
});
