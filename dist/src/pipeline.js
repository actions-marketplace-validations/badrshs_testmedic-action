import fs from 'node:fs';
import { parseReport } from './report.js';
import { classify } from './classify.js';
import { requestPatch } from './heal.js';
import { buildHealPrompt } from './prompts.js';
import { applyEdits, revertFile } from './patch.js';
import { verifyTest } from './verify.js';
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
async function healOneTest(test, classificationReason, options) {
    const { log } = options;
    const testSource = fs.readFileSync(test.file, 'utf8');
    let patch = await requestPatch(buildHealPrompt({
        errorContext: test.errorContext,
        testFilePath: test.file,
        testSource,
        classificationReason,
    }), options.model);
    if (!patch) {
        log(`  model returned no parseable patch; reporting as bug`);
        return { kind: 'bug', bug: { test, reason: 'Healing failed: model returned no usable patch' } };
    }
    if (patch.verdict !== 'heal') {
        log(`  model verdict: ${patch.verdict} (${patch.explanation.slice(0, 120)})`);
        return {
            kind: 'bug',
            bug: { test, reason: `Model judged this a ${patch.verdict === 'bug' ? 'real bug' : 'case to skip'}`, explanation: patch.explanation },
        };
    }
    if (patch.confidence < options.minConfidence) {
        log(`  confidence ${patch.confidence} below threshold ${options.minConfidence}; not healing`);
        return {
            kind: 'bug',
            bug: { test, reason: `Heal confidence too low (${patch.confidence})`, explanation: patch.explanation },
        };
    }
    log(`  proposed: ${patch.old_selector} -> ${patch.new_selector} (confidence ${patch.confidence})`);
    if (options.mode === 'dry-run') {
        return { kind: 'healed', record: { test, patch, verified: false, applied: false } };
    }
    let applied = applyEdits(test.file, patch.edits);
    if (!applied.ok) {
        log(`  patch did not apply (${applied.reason}); retrying once with feedback`);
        patch = await requestPatch(buildHealPrompt({
            errorContext: test.errorContext,
            testFilePath: test.file,
            testSource,
            classificationReason,
            previousAttempt: applied.reason,
        }), options.model);
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
    if (!verification.passed) {
        revertFile(test.file, applied.original);
        log(`  verification failed; patch reverted`);
        return {
            kind: 'bug',
            bug: {
                test,
                reason: 'A repaired selector still fails, so the behavior itself is broken',
                explanation: patch.explanation,
            },
        };
    }
    log(`  verified green`);
    return { kind: 'healed', record: { test, patch, verified: true, applied: true } };
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
