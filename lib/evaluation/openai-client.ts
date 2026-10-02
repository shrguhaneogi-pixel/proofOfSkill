import { OpenAI, type ClientOptions } from "openai";

import { DEFAULT_TIMEOUT_MS } from "./evaluator";
import type { ChatCompletionClient, EvaluatorRequestBody, EvaluatorResponseBody } from "./types";

export type EvaluatorClientConfig = {
  /** From `AI_API_KEY`; validated by the caller (`lib/env.server.ts`). */
  apiKey: string;
  /** From `AI_BASE_URL`; an OpenAI-compatible `/v1` root. */
  baseURL: string;
  /** From `AI_MODEL`; surfaced as `EvaluationResult.provider`. */
  model: string;
  /** Per-request deadline handed to the SDK. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Test seam: the SDK's own `fetch` override (`ClientOptions.fetch`). Lets the
   * adapter be verified against the real request/response path without a network.
   * Production callers leave it undefined.
   */
  fetch?: ClientOptions["fetch"];
};

/**
 * Retry policy lives in `evaluator.ts`, which knows the difference between an
 * unusable JSON body and a 429. Left at the SDK default of 2 (`client.d.ts:217`)
 * it would turn our 2 attempts into 3 HTTP requests each, so the client is built
 * with `maxRetries: 0` and the ceiling really is two paid calls.
 */
const SDK_MAX_RETRIES = 0;

/** Thrown for a programmer error (empty config), never for a request failure. */
export class EvaluatorConfigError extends Error {
  constructor(field: string) {
    super(`createOpenAIClient was given an empty "${field}". Validate env before building the client.`);
    this.name = "EvaluatorConfigError";
  }
}

function requireField(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new EvaluatorConfigError(field);
  }
  return trimmed;
}

/**
 * Builds the real transport. No request is made until `create` is called, and no
 * environment variable is read: `baseURL`, `apiKey` and `timeout` are all passed
 * explicitly, which also prevents the SDK's own `OPENAI_BASE_URL` fallback
 * (`client.mjs:175`) from applying.
 */
export function createOpenAIClient(config: EvaluatorClientConfig): ChatCompletionClient {
  const apiKey = requireField(config.apiKey, "apiKey");
  const baseURL = requireField(config.baseURL, "baseURL");
  const model = requireField(config.model, "model");

  const openai = new OpenAI({
    apiKey,
    baseURL,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: SDK_MAX_RETRIES,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });

  return {
    model,
    async create(body: EvaluatorRequestBody): Promise<EvaluatorResponseBody> {
      const completion = await openai.chat.completions.create({
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
        response_format: body.response_format,
      });

      return {
        choices: completion.choices.map((choice) => ({
          message: { content: choice.message?.content ?? null },
        })),
      };
    },
  };
}
