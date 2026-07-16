import path from 'node:path';
import { runPipeline } from './pipeline.js';
function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1 || index === process.argv.length - 1)
        return fallback;
    return process.argv[index + 1];
}
const mode = arg('mode', 'dry-run') ?? 'dry-run';
const workingDirectory = path.resolve(arg('cwd', process.cwd()));
const reportPath = path.resolve(workingDirectory, arg('report', 'test-results/results.json'));
runPipeline({
    reportPath,
    workingDirectory,
    repoRoot: path.resolve(arg('repo-root', workingDirectory)),
    mode: mode === 'heal' ? 'heal-local' : mode,
    model: arg('model', 'claude-sonnet-5'),
    maxHeals: Number(arg('max-heals', '3')),
    minConfidence: Number(arg('min-confidence', '0.6')),
    testCommand: arg('test-command', 'npx playwright test'),
    runId: 'local',
    runUrl: '(local run)',
    baseBranch: 'main',
    log: (message) => console.log(message),
})
    .then((result) => {
    console.log('\n=== testmedic summary ===');
    console.log(`failed: ${result.failedCount}`);
    for (const heal of result.heals) {
        const status = heal.applied ? (heal.verified ? 'applied + verified' : 'applied') : 'proposed';
        console.log(`heal (${status}): ${heal.test.title}`);
        console.log(`  ${heal.patch.old_selector} -> ${heal.patch.new_selector}`);
        console.log(`  why: ${heal.patch.explanation}`);
        for (const edit of heal.patch.edits) {
            console.log(`  - ${edit.old_string}`);
            console.log(`  + ${edit.new_string}`);
        }
    }
    for (const bug of result.bugs) {
        console.log(`bug: ${bug.test.title}`);
        console.log(`  why: ${bug.reason}${bug.explanation ? ` / ${bug.explanation}` : ''}`);
    }
    for (const infra of result.infra) {
        console.log(`infra (ignored): ${infra.test.title} (${infra.reason})`);
    }
})
    .catch((error) => {
    console.error(`testmedic failed: ${error.message}`);
    process.exit(1);
});
