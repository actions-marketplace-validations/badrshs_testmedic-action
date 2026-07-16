import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from './pipeline.js';
function env(name, fallback = '') {
    return process.env[name]?.trim() || fallback;
}
function writeOutput(name, value) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile && value)
        fs.appendFileSync(outputFile, `${name}=${value}\n`);
}
async function main() {
    const workspace = env('GITHUB_WORKSPACE', process.cwd());
    const workingDirectory = path.resolve(workspace, env('TM_WORKING_DIRECTORY', '.'));
    const reportPath = path.resolve(workingDirectory, env('TM_REPORT', 'test-results/results.json'));
    const runId = env('GITHUB_RUN_ID', String(Date.now()));
    const runUrl = `${env('GITHUB_SERVER_URL', 'https://github.com')}/${env('GITHUB_REPOSITORY')}/actions/runs/${runId}`;
    if (!env('CLAUDE_CODE_OAUTH_TOKEN') && !env('ANTHROPIC_API_KEY')) {
        throw new Error('No AI credential: set the claude-code-oauth-token or anthropic-api-key input (repo secret).');
    }
    if (env('GITHUB_HEAD_REF').startsWith('heal/')) {
        console.log('This run is for a heal PR; refusing to heal a heal. Exiting.');
        return;
    }
    const result = await runPipeline({
        reportPath,
        workingDirectory,
        repoRoot: workspace,
        mode: env('TM_MODE', 'heal') ?? 'heal',
        model: env('TM_MODEL', 'claude-sonnet-5'),
        maxHeals: Number(env('TM_MAX_HEALS', '3')),
        minConfidence: Number(env('TM_MIN_CONFIDENCE', '0.6')),
        testCommand: env('TM_TEST_COMMAND', 'npx playwright test'),
        runId,
        runUrl,
        baseBranch: env('TM_BASE_BRANCH') || env('GITHUB_HEAD_REF') || env('GITHUB_REF_NAME', 'main'),
        log: (message) => console.log(message),
    });
    writeOutput('pr-url', result.prUrl ?? '');
    writeOutput('issue-urls', result.issueUrls.join(','));
    writeOutput('healed-count', String(result.heals.filter((h) => h.verified).length));
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
        const lines = [
            '## testmedic',
            `- Failed tests: ${result.failedCount}`,
            `- Healed and verified: ${result.heals.filter((h) => h.verified).length}${result.prUrl ? ` -> ${result.prUrl}` : ''}`,
            `- Reported as bugs: ${result.bugs.length}${result.issueUrls.length ? ` -> ${result.issueUrls.join(', ')}` : ''}`,
            `- Ignored as infra/flaky: ${result.infra.length}`,
        ];
        fs.appendFileSync(summaryFile, lines.join('\n') + '\n');
    }
}
main().catch((error) => {
    console.error(`testmedic failed: ${error.message}`);
    process.exit(1);
});
