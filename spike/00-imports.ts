import * as M from "@mozaik-ai/core"

const need = [
	"Agent", "Human", "createAgent", "createHuman", "defineRuntime", "RuntimeState",
	"SemanticEvent", "SituationSpecification", "ModelContext", "Memory",
	"UserMessageItem", "DeveloperMessageItem", "SystemMessageItem", "ModelMessageItem",
	"FunctionCallItem", "FunctionCallOutputItem", "ReasoningItem",
	"DefaultInferenceRunner", "AnthropicMessages", "OpenAIResponses",
	"OpenAIChatCompletions", "GeminiGenerateContent", "supportedModels",
	"McpClient", "McpToolRegistry", "Participant", "ContextItem",
]

const missing: string[] = []
for (const n of need) if (!(n in M)) missing.push(n)

console.log("exports present:", need.length - missing.length, "/", need.length)
if (missing.length) console.log("MISSING:", missing.join(", "))

const models = (M as any).supportedModels as any[]
console.log("supportedModels count:", models.length)
console.log("\nproviders:", [...new Set(models.map(m => m.specification.provider))].join(", "))
console.log("\nAll model specs:")
for (const m of models) {
	const s = m.specification
	console.log(`  ${s.provider.padEnd(10)} ${s.name.padEnd(26)} efforts=[${(s.supportedReasoningEfforts||[]).join("|")}] stream=${s.supportsStreaming} maxOut=${s.maxOutputTokens} fn=${s.supportsFunctionCalling} struct=${s.supportsStructuredOutput}`)
}
