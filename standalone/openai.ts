import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response } from "openai/resources/responses/responses";
import { z } from "zod";
import type { LlmPort } from "../src/llm";

/**
 * The model settings: which model, how hard it thinks, and what it may spend. Model names live in this file
 * only (`config/llm.json`), never in code.
 */
const llmConfigSchema = z
	.object({
		provider: z.literal("openai"),
		model: z.string().min(1),
		effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
		/** Room for reasoning on top of the stage's visible answer. */
		thinkingHeadroom: z.number().int().min(0),
		outputCap: z.number().int().min(1),
		timeoutMs: z.number().int().min(1000),
		spend: z
			.object({
				limitUsd: z.number().positive(),
				usdPerMillionTokens: z.record(
					z.string(),
					z
						.object({
							input: z.number().min(0),
							cachedInput: z.number().min(0),
							output: z.number().min(0),
						})
						.strict(),
				),
			})
			.strict(),
	})
	.strict();
export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const defaultLlmConfigPath = join(
	import.meta.dir,
	"..",
	"config",
	"llm.json",
);

export function readLlmConfig(path = defaultLlmConfigPath): LlmConfig {
	return llmConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** A failed model call with a fixed code: what the runner records as the stage's error. */
export class LlmCallError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
	) {
		super(code);
		this.name = "LlmCallError";
	}
}

/** Exported login-shell variables (`zsh -l`); no profile or env file is read here. */
export function openAIKey(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	for (const name of ["OPEN_AI_API_KEY", "OPENAI_API_KEY"]) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	throw new LlmCallError("llm_api_key_missing", false);
}

/** What the calls cost so far; a call that would start past the limit is refused. */
export function createSpendMeter(config: LlmConfig) {
	let spentUsd = 0;
	let calls = 0;
	const price = (model: string) => {
		const rates = config.spend.usdPerMillionTokens[model];
		if (!rates) throw new LlmCallError("llm_price_missing", false);
		return rates;
	};
	price(config.model);
	return {
		assertWithinLimit() {
			if (spentUsd >= config.spend.limitUsd)
				throw new LlmCallError("llm_spend_limit", false);
		},
		record(
			model: string,
			usage: { input: number; cached: number; output: number },
		) {
			const rates = price(model);
			calls++;
			spentUsd +=
				((usage.input - usage.cached) * rates.input +
					usage.cached * rates.cachedInput +
					usage.output * rates.output) /
				1_000_000;
		},
		summary: () => ({ calls, spentUsd }),
	};
}
export type SpendMeter = ReturnType<typeof createSpendMeter>;

/**
 * The provider's prompt cache matches a prompt's leading tokens (from 1,024 on) and routes by this key. Calls
 * of the same stage share their instructions and output schema, so the stage's system context names the key:
 * those calls land on the same cache. There is no session: every stage is one stateless call that receives
 * its inputs explicitly.
 */
export const promptCacheKey = (system: string) =>
	`thought-plan:${createHash("sha256").update(system).digest("hex").slice(0, 32)}`;

const textOf = (response: Response) =>
	response.output
		.flatMap((item) =>
			item.type === "message"
				? item.content.flatMap((part) =>
						part.type === "output_text" ? [part.text] : [],
					)
				: [],
		)
		.join("");

function mapError(error: unknown, signal: AbortSignal): never {
	if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
		throw error;
	if (error instanceof LlmCallError) throw error;
	if (error instanceof OpenAI.APIConnectionError)
		throw new LlmCallError("llm_connection", true);
	if (error instanceof OpenAI.APIError)
		throw new LlmCallError(
			`llm_api_${error.status ?? 0}`,
			error.status === 429 || (error.status ?? 0) >= 500,
		);
	throw new LlmCallError("llm_call_failed", false);
}

/**
 * The OpenAI Responses API as the runner's model port, the same call shape `eumenes-agency` uses: strict
 * structured output from the stage's schema, nothing stored on the provider side, the configured model and
 * reasoning effort, and a check that the model that answered is the one configured.
 */
export function createOpenAILlm(
	config: LlmConfig,
	meter: SpendMeter = createSpendMeter(config),
	client = new OpenAI({
		apiKey: openAIKey(),
		maxRetries: 0,
		timeout: config.timeoutMs,
	}),
): LlmPort {
	return {
		async complete(request, signal) {
			meter.assertWithinLimit();
			const started = performance.now();
			try {
				const response = await client.responses.create(
					{
						model: config.model,
						instructions: request.system,
						input: request.prompt,
						prompt_cache_key: promptCacheKey(request.system),
						store: false,
						reasoning: { effort: config.effort },
						max_output_tokens: Math.min(
							config.outputCap,
							request.maxOutputTokens + config.thinkingHeadroom,
						),
						text: { format: zodTextFormat(request.schema, "stage_output") },
					},
					{ signal },
				);
				if (!response.usage) throw new LlmCallError("llm_usage_missing", false);
				const usage = response.usage;
				meter.record(response.model, {
					input: usage.input_tokens,
					cached: usage.input_tokens_details.cached_tokens,
					output: usage.output_tokens,
				});
				if (response.model !== config.model)
					throw new LlmCallError("llm_model_not_confirmed", false);
				if (
					response.output.some(
						(item) =>
							item.type === "message" &&
							item.content.some((part) => part.type === "refusal"),
					)
				)
					throw new LlmCallError("llm_refusal", false);
				if (response.status !== "completed")
					throw new LlmCallError(
						response.incomplete_details?.reason === "max_output_tokens"
							? "llm_max_tokens"
							: "llm_incomplete",
						false,
					);
				let raw: unknown;
				try {
					raw = JSON.parse(textOf(response));
				} catch {
					throw new LlmCallError("llm_output_not_json", false);
				}
				const parsed = request.schema.safeParse(raw);
				if (!parsed.success) throw new LlmCallError("llm_output_schema", false);
				return {
					value: parsed.data,
					model: response.model,
					inputTokens: usage.input_tokens,
					outputTokens: usage.output_tokens,
					cacheReadTokens: usage.input_tokens_details.cached_tokens,
					latencyMs: performance.now() - started,
				};
			} catch (error) {
				return mapError(error, signal);
			}
		},
	};
}
