import fs from 'node:fs';
import path from 'node:path';
const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + '\\[' + '[0-9;]*m', 'g');
export function stripAnsi(text) {
    return text.replace(ANSI_PATTERN, '');
}
export function parseReport(reportPath) {
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const rootDir = raw.config?.rootDir ?? '';
    const failed = [];
    const walk = (suite, chain) => {
        for (const spec of suite.specs ?? []) {
            for (const test of spec.tests ?? []) {
                if (test.status !== 'unexpected')
                    continue;
                const last = test.results?.[test.results.length - 1];
                if (!last || last.status === 'passed')
                    continue;
                const attachments = (last.attachments ?? []).map((a) => ({
                    name: a.name,
                    path: a.path,
                    contentType: a.contentType,
                }));
                const contextAttachment = attachments.find((a) => a.name === 'error-context');
                let errorContext;
                if (contextAttachment?.path && fs.existsSync(contextAttachment.path)) {
                    errorContext = fs.readFileSync(contextAttachment.path, 'utf8');
                }
                failed.push({
                    title: spec.title,
                    titlePath: [...chain, spec.title],
                    file: path.resolve(rootDir, spec.file),
                    line: spec.line,
                    projectName: test.projectName ?? '',
                    status: last.status,
                    errors: (last.errors ?? []).map((e) => ({
                        ...e,
                        message: stripAnsi(e.message ?? ''),
                    })),
                    errorContext,
                    attachments,
                });
            }
        }
        for (const child of suite.suites ?? [])
            walk(child, [...chain, child.title]);
    };
    for (const suite of raw.suites ?? [])
        walk(suite, [suite.title]);
    return { rootDir, failed };
}
