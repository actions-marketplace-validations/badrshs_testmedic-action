import { z } from 'zod';
export const PatchSchema = z.object({
    verdict: z.enum(['heal', 'bug', 'skip']),
    explanation: z.string(),
    old_selector: z.string().default(''),
    new_selector: z.string().default(''),
    edits: z
        .array(z.object({ old_string: z.string(), new_string: z.string() }))
        .default([]),
    confidence: z.number().min(0).max(1),
    suggested_app_fix: z.string().default(''),
});
export const SYSTEM_PROMPT = `You are testmedic, an expert Playwright test repair agent running inside CI.

Your single job: given a failed Playwright test with the page snapshot captured at the moment of failure, decide whether the failure is UI drift (the app still works, only the selector or surface changed) and if so, repair the test's locator.

Hard rules:
- NEVER change assertions, expected values, or the intent of the test. You repair how the test finds elements, nothing else.
- If the element the test needs does not exist anywhere in the page snapshot, the feature is missing or broken: verdict "bug".
- If you cannot tell with reasonable confidence, verdict "skip". A wrong heal that masks a regression is the worst possible outcome. Default to no.
- Prefer resilient, user-facing locators: getByRole with accessible name, getByLabel, getByText. Avoid ids and CSS classes when a role-based locator uniquely matches.
- Edits must be exact literal replacements against the test source: old_string must appear exactly once in the file, and must include enough surrounding context to be unique.

Write the explanation in plain language a reviewer skims in ten seconds. Use simple punctuation only: no em dashes.

When your verdict is "bug" and the evidence shows you the likely root cause in the application itself (for example the DOM digest reveals a renamed id while scripts or labels still reference the old one), describe the minimal application-side fix in suggested_app_fix: name the file or component if visible, what to change, and a short code sketch. It is shown to a human as an unverified suggestion, never applied automatically. Leave it empty when you cannot see the root cause.

Respond with ONLY a JSON object, no prose around it, in this shape:
{
  "verdict": "heal" | "bug" | "skip",
  "explanation": "one short paragraph explaining the diagnosis in plain language",
  "old_selector": "the selector that failed",
  "new_selector": "the replacement locator",
  "edits": [{ "old_string": "exact text in the test file", "new_string": "replacement text" }],
  "confidence": 0.0 to 1.0
}
For verdict "bug" or "skip", leave edits empty and explain what you found instead.`;
export function buildHealPrompt(options) {
    const retryNote = options.previousAttempt
        ? `\n\nIMPORTANT: a previous attempt failed to apply: ${options.previousAttempt}. Produce corrected edits (old_string must match the file exactly and be unique).`
        : '';
    const digestSection = options.domDigest
        ? `\n\n=== LIVE DOM DIGEST (fetched from the pages this test visits; the aria snapshot above has no ids, this does) ===\n${options.domDigest}\n=== END DOM DIGEST ===`
        : '';
    const verifySection = options.verifyFailure
        ? `\n\nIMPORTANT: a previous repair was applied and the test STILL FAILED on re-run. Do not repeat that approach. Previous attempt result:\n${options.verifyFailure}\nPropose a different repair, or verdict "bug" if you now believe the behavior itself is broken.`
        : '';
    return `A Playwright test failed in CI. Our deterministic classifier says: ${options.classificationReason}.

Below is the failure report Playwright produced (error, page snapshot at the moment of failure, and annotated test source), followed by the complete current content of the test file.

=== PLAYWRIGHT FAILURE REPORT ===
${options.errorContext}

=== FULL TEST FILE: ${options.testFilePath} ===
${options.testSource}
=== END TEST FILE ===${digestSection}${verifySection}

Diagnose and respond with the JSON object only.${retryNote}`;
}
