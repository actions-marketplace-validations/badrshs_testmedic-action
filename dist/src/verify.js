import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Re-run a single test by exact title (never by file:line, since patching
 * shifts line numbers) and report whether it passes now.
 */
export function verifyTest(options) {
    const jsonOut = path.join(os.tmpdir(), `testmedic-verify-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const relFile = path.relative(options.cwd, options.specFile).split(path.sep).join('/');
    const grep = escapeRegex(options.title);
    // Isolated artifact dir: without it, Playwright clears the original run's
    // test-results (evidence, error contexts) at the start of the re-run.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testmedic-verify-out-'));
    const command = `${options.testCommand} "${relFile}" -g "${grep}" --reporter=json --output "${outputDir}"`;
    const run = spawnSync(command, {
        cwd: options.cwd,
        shell: true,
        encoding: 'utf8',
        timeout: 10 * 60_000,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonOut },
    });
    let passed = run.status === 0;
    // Exit code 0 with zero tests run would be a false positive; confirm at
    // least one test actually executed when the report is available.
    try {
        if (fs.existsSync(jsonOut)) {
            const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
            const stats = report.stats ?? {};
            const ran = (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);
            if (ran === 0)
                passed = false;
            fs.unlinkSync(jsonOut);
        }
    }
    catch {
        // keep exit-code verdict
    }
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim();
    return { passed, output: output.slice(-4000) };
}
