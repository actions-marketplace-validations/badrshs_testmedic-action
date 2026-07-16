import { query } from '@anthropic-ai/claude-agent-sdk';
import { PatchSchema, SYSTEM_PROMPT } from './prompts.js';
export async function requestPatch(prompt, model) {
    let resultText = '';
    const stream = query({
        prompt,
        options: {
            model,
            systemPrompt: SYSTEM_PROMPT,
            allowedTools: [],
            maxTurns: 1,
        },
    });
    for await (const message of stream) {
        if (message.type === 'result') {
            if (message.subtype === 'success')
                resultText = message.result;
            else
                throw new Error(`Model call failed: ${message.subtype}`);
        }
    }
    return extractPatch(resultText);
}
export function extractPatch(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start)
        return null;
    try {
        return PatchSchema.parse(JSON.parse(candidate.slice(start, end + 1)));
    }
    catch {
        return null;
    }
}
