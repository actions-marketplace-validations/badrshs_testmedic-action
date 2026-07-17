import fs from 'node:fs';
import { parseReport } from './report.js';
import { classify } from './classify.js';
import { requestPatch } from './heal.js';
import { buildHealPrompt } from './prompts.js';
import { applyEdits, revertFile } from './patch.js';
import { verifyTest } from './verify.js';
import { extractGotoPaths, detectBaseUrl, fetchDomDigest } from './dom.js';
import { createHealPullRequest, createBugIssues, currentBranch, } from './deliver.js';
export async function runPipeline(options) {
    const { log } = options;
    const result = { failedCount: 0, heals: [], bugs: [], infra: [], issueUrls: [] };
    if (options.mode === 'heal') {
        const branch = currentBranch(options.repoRoot);
        if (branch.startsWith('heal/')) {
            log(`On healing branch ${branch}; refusing to heal a heal. Exiting.`);
            return result;
        }
    }
    if (!fs.existsSync(options.reportPath)) {
        throw new Error(`Playwright JSON report not found at ${options.reportPath}`);
    }
    const { failed } = parseReport(options.reportPath);
    result.failedCount = failed.length;
    log(`${failed.length} failed test(s) in report`);
    let healBudget = options.maxHeals;
    for (const test of failed) {
        const verdict = classify(test);
        log(`- "${test.title}": ${verdict.category} (${verdict.reason})`);
        if (verdict.category === 'infra') {
            result.infra.push({ test, reason: verdict.reason });
            continue;
        }
        if (verdict.category === 'real-bug' || options.mode === 'issue-only') {
            result.bugs.push({ test, reason: verdict.reason });
            continue;
        }
        // healable or ambiguous: let the model judge, bounded by budget
        if (healBudget <= 0) {
            log(`  heal budget exhausted (max-heals); reporting as bug instead`);
            result.bugs.push({ test, reason: `${verdict.reason} (heal budget exhausted)` });
            continue;
        }
        if (!test.errorContext) {
            result.bugs.push({ test, reason: `${verdict.reason}, and no error context was captured` });
            continue;
        }
        healBudget -= 1;
        const healed = await healOneTest(test, verdict.reason, options);
        if (healed.kind === 'healed') {
            result.heals.push(healed.record);
        }
        else {
            result.bugs.push(healed.bug);
        }
    }
    deliver(result, options);
    return result;
}
const VERIFY_ROUNDS = 2;
async function healOneTest(test, classificationReason, options) {
    const { log } = options;
    const testSource = fs.readFileSync(test.file, 'utf8');
    const domDigest = await collectDomDigest(testSource, options);
    let verifyFeedback;
    let lastExplanation;
    for (let round = 1; round <= VERIFY_ROUNDS; round++) {
        const prompt = (previousAttempt) => buildHealPrompt({
            errorContext: test.errorContext,
            testFilePath: test.file,
            testSource,
            classificationReason,
            previousAttempt,
            domDigest,
            verifyFailure: verifyFeedback,
        });
        let patch = await requestPatch(prompt(), options.model);
        if (!patch) {
            log(`  model returned no parseable patch; reporting as bug`);
            return { kind: 'bug', bug: { test, reason: 'Healing failed: model returned no usable patch' } };
        }
        if (patch.verdict !== 'heal') {
            log(`  model verdict: ${patch.verdict} (${patch.explanation.slice(0, 120)})`);
            return {
                kind: 'bug',
                bug: {
                    test,
                    reason: `Model judged this a ${patch.verdict === 'bug' ? 'real bug' : 'case to skip'}`,
                    explanation: patch.explanation,
                },
            };
        }
        if (patch.confidence < options.minConfidence) {
            log(`  confidence ${patch.confidence} below threshold ${options.minConfidence}; not healing`);
            return {
                kind: 'bug',
                bug: {
                    test,
                    reason: `Heal confidence too low (${patch.confidence})`,
                    explanation: patch.explanation,
                },
            };
        }
        log(`  round ${round}: proposed ${patch.old_selector} -> ${patch.new_selector} (confidence ${patch.confidence})`);
        lastExplanation = patch.explanation;
        if (options.mode === 'dry-run') {
            return { kind: 'healed', record: { test, patch, verified: false, applied: false } };
        }
        let applied = applyEdits(test.file, patch.edits);
        if (!applied.ok) {
            log(`  patch did not apply (${applied.reason}); retrying once with feedback`);
            patch = await requestPatch(prompt(applied.reason), options.model);
            if (!patch || patch.verdict !== 'heal') {
                return { kind: 'bug', bug: { test, reason: 'Healing failed: patch could not be applied' } };
            }
            applied = applyEdits(test.file, patch.edits);
            if (!applied.ok) {
                return {
                    kind: 'bug',
                    bug: { test, reason: `Healing failed: patch could not be applied (${applied.reason})` },
                };
            }
        }
        log(`  patch applied; verifying by re-running the test`);
        const verification = verifyTest({
            cwd: options.workingDirectory,
            testCommand: options.testCommand,
            specFile: test.file,
            title: test.title,
        });
        if (verification.passed) {
            log(`  verified green`);
            return { kind: 'healed', record: { test, patch, verified: true, applied: true } };
        }
        revertFile(test.file, applied.original);
        log(`  round ${round}: verification failed; patch reverted`);
        verifyFeedback = `Tried: ${patch.old_selector} -> ${patch.new_selector} (edits applied, test re-run, still failed).\nRe-run output tail:\n${verification.output.slice(-1500)}`;
    }
    return {
        kind: 'bug',
        bug: {
            test,
            reason: `Still failing after ${VERIFY_ROUNDS} verified repair attempts, so the behavior itself likely changed`,
            explanation: lastExplanation,
        },
    };
}
async function collectDomDigest(testSource, options) {
    try {
        const paths = extractGotoPaths(testSource);
        if (paths.length === 0)
            return undefined;
        const baseUrl = detectBaseUrl(options.workingDirectory);
        if (!baseUrl) {
            options.log('  dom digest: no baseURL found (config or base-url input); skipping');
            return undefined;
        }
        return await fetchDomDigest(baseUrl, paths, options.log);
    }
    catch (error) {
        options.log(`  dom digest failed (${error?.message ?? error}); continuing without it`);
        return undefined;
    }
}
function deliver(result, options) {
    const { log } = options;
    const verifiedHeals = result.heals.filter((h) => h.applied && h.verified);
    if (options.mode === 'heal' && verifiedHeals.length > 0) {
        result.prUrl = createHealPullRequest({
            repoRoot: options.repoRoot,
            heals: verifiedHeals,
            runId: options.runId,
            runUrl: options.runUrl,
            baseBranch: options.baseBranch,
        });
        log(`opened heal PR: ${result.prUrl}`);
    }
    if ((options.mode === 'heal' || options.mode === 'issue-only') && result.bugs.length > 0) {
        result.issueUrls = createBugIssues({
            repoRoot: options.repoRoot,
            bugs: result.bugs,
            runUrl: options.runUrl,
        });
        for (const url of result.issueUrls)
            log(`opened issue: ${url}`);
    }
    if (options.mode === 'dry-run' || options.mode === 'heal-local') {
        log('local mode: nothing sent to GitHub');
    }
}
