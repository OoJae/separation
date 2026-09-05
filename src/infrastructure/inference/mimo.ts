import { AnthropicMessages } from "@mozaik-ai/core"
import type { Endpoint } from "@mozaik-ai/core"

/**
 * `GenerativeModel` and `ModelSpecification` are declared in the package but NOT exported, even
 * though the exported `InferenceRunnerConfig` asks for `supportedModels?: GenerativeModel[]`.
 * You cannot name the type the public config requires. See docs/API-NOTES.md #20.
 *
 * Declared structurally here, matching the shipped shape field-for-field.
 */
export type ModelSpecificationLike = {
	readonly name: string
	readonly provider: string
	readonly supportsReasoningEffort: boolean
	readonly supportedReasoningEfforts: readonly string[]
	readonly supportedContextItemTypes: readonly string[]
	readonly supportsStreaming: boolean
	readonly contextWindowSize: number
	readonly maxOutputTokens: number
	readonly supportsFunctionCalling: boolean
	readonly supportsStructuredOutput: boolean
}

export type GenerativeModelLike = {
	readonly endpoint: Endpoint
	readonly specification: ModelSpecificationLike
}

/**
 * MiMo (Xiaomi) — an Anthropic-protocol-compatible endpoint.
 *
 * Registered as a custom `GenerativeModel` rather than relying on the bundled roster, which is
 * exactly the extension point mozaik documents: an `Endpoint` adapter plus a `ModelSpecification`.
 * The shipped `AnthropicMessages` adapter takes a `{baseURL, apiKey}` config, so pointing it at a
 * compatible third party needs no new provider code at all — a genuinely good piece of design in
 * the framework, and worth saying so.
 *
 * Behaviour verified against the live endpoint before any code depended on it:
 *
 *  - Tool calling works; `stop_reason: "tool_use"`, correct `input`.
 *  - A multi-turn `tool_use` -> `tool_result` round trip works.
 *  - `thinking` blocks come back with an EMPTY `signature`, and MiMo ACCEPTS them echoed back.
 *    Real Anthropic rejects an empty signature, so a context that survives here would 400 there.
 *    We strip ReasoningItems anyway (orphan-repair.ts), which turns out to be the portable choice
 *    rather than merely a defensive one.
 *  - `max_tokens` is optional here but required by real Anthropic; the mapper does
 *    `request.max_tokens = inferenceInput.maxOutputTokens!`, so we always set it regardless.
 *
 * `supportsReasoningEffort` is FALSE deliberately. MiMo emits thinking blocks unprompted, and
 * setting an effort makes the mapper add `thinking: {type:"adaptive"}` + `output_config.effort`,
 * which measurably lengthens the response and consumed the whole token budget on a trivial prompt
 * (a "say ok" test hit `stop_reason: max_tokens`). Declaring it false keeps the budget for output.
 */
export const MIMO_MODEL_NAME = "mimo-v2.5-pro"
export const MIMO_PROVIDER = "mimo"

export function mimoModel(config: { readonly baseURL: string; readonly apiKey: string }): GenerativeModelLike {
	return {
		endpoint: new AnthropicMessages(undefined, { baseURL: config.baseURL, apiKey: config.apiKey }),
		specification: {
			name: MIMO_MODEL_NAME,
			provider: MIMO_PROVIDER,
			supportsReasoningEffort: false,
			supportedReasoningEfforts: [],
			supportedContextItemTypes: [
				"user_message", "system_message", "developer_message",
				"function_call", "function_call_output", "model_message",
			],
			supportsStreaming: true,
			contextWindowSize: 200_000,
			maxOutputTokens: 8_192,
			supportsFunctionCalling: true,
			supportsStructuredOutput: false,
		},
	}
}

/** Reads MiMo config from the environment. Returns null when it is not configured. */
export function mimoFromEnv(env: NodeJS.ProcessEnv = process.env): GenerativeModelLike | null {
	const apiKey = env.ANTHROPIC_API_KEY
	const baseURL = env.ANTHROPIC_BASE_URL
	if (!apiKey || !baseURL) return null
	return mimoModel({ baseURL, apiKey })
}
