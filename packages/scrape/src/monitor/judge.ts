import { generateObject, getExtractModelId, getLLM } from "@anycrawl/ai";
import { z } from "zod";
import { log } from "@anycrawl/libs";

const verdictSchema = z.object({
    meaningful: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
    reason: z.string(),
});

export interface JudgmentResult {
    meaningful: boolean | null;
    confidence: "low" | "medium" | "high";
    reason: string;
    status: "complete" | "unavailable" | "incomplete";
}

/**
 * Ask an LLM whether a diff is meaningful relative to a user-defined goal.
 *
 * Unknown judgment preserves the change. It is never disguised as a normal
 * meaningful/unchanged result, and no alternate provider is selected here.
 */
export async function judgeChange(
    goal: string,
    diffText: string,
    url: string,
    options: { complete?: boolean } = {}
): Promise<JudgmentResult> {
    if (options.complete === false || goal.length + diffText.length + url.length > 20_000) {
        return { meaningful: null, confidence: "low", status: "incomplete", reason: "The full change exceeds the AI input limit; review the recorded diff" };
    }
    const systemPrompt = `You are a change-detection judge. Your only job is to decide whether an observed diff on a web page is meaningful relative to the stated monitoring goal.

Ignore mechanical noise such as rotating tokens, session IDs, footer timestamps, ad slots, or cache-buster query strings.

Respond ONLY with a JSON object matching the schema: { meaningful: boolean, confidence: "low"|"medium"|"high", reason: string }.`;

    const userPrompt = `Monitoring goal: "${goal}"

URL: ${url}

Complete text and structured field changes:
${diffText}

Is this change meaningful relative to the goal?`;

    try {
        // Inside the try: with no LLM provider configured this throws, and the
        // unknown judgment below must still be recorded (see docstring).
        const modelId = getExtractModelId();
        const generateObjectFn = generateObject as any;
        const { object } = await generateObjectFn({
            model: getLLM(modelId),
            system: systemPrompt,
            prompt: userPrompt,
            schema: verdictSchema,
            abortSignal: AbortSignal.timeout(60_000),
        });
        return { ...object, status: "complete" } as JudgmentResult;
    } catch (err) {
        log.warning(`[MONITOR JUDGE] LLM judgment failed for ${url}: ${err}`);
        return { meaningful: null, confidence: "low", status: "unavailable", reason: "AI judgment is unavailable; the detected change has been retained" };
    }
}
