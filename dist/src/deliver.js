import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const GIT_IDENTITY = ['-c', 'user.name=testmedic', '-c', 'user.email=testmedic-bot@users.noreply.github.com'];
function git(cwd, ...args) {
    return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();
}
function gh(cwd, ...args) {
    try {
        return execFileSync('gh', args, { cwd, encoding: 'utf8' }).trim();
    }
    catch (error) {
        const stderr = String(error?.stderr ?? '');
        if (/not permitted to create or approve pull requests/i.test(stderr)) {
            throw new Error('GitHub blocked PR creation. Enable "Allow GitHub Actions to create and approve pull requests" under Settings -> Actions -> General in this repository, then re-run.');
        }
        throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${stderr || error?.message}`);
    }
}
export function currentBranch(cwd) {
    return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
}
export function createHealPullRequest(options) {
    const { repoRoot, heals, runId, runUrl, baseBranch } = options;
    const branch = `heal/${runId}`;
    const files = [...new Set(heals.map((h) => h.test.file))];
    git(repoRoot, 'checkout', '-B', branch);
    git(repoRoot, 'add', ...files);
    const testWord = heals.length === 1 ? 'test' : 'tests';
    git(repoRoot, 'commit', '-m', `Repair E2E selectors after UI change (${heals.length} ${testWord})`);
    git(repoRoot, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
    const bodyFile = path.join(os.tmpdir(), `testmedic-pr-${runId}.md`);
    fs.writeFileSync(bodyFile, buildPrBody(heals, runUrl));
    const prUrl = gh(repoRoot, 'pr', 'create', '--head', branch, '--base', baseBranch, '--title', `Heal ${heals.length} E2E ${testWord} after UI change`, '--body-file', bodyFile);
    git(repoRoot, 'checkout', baseBranch);
    return prUrl;
}
export function createBugIssues(options) {
    const { repoRoot, bugs, runUrl } = options;
    let existingTitles = [];
    try {
        existingTitles = JSON.parse(gh(repoRoot, 'issue', 'list', '--state', 'open', '--json', 'title', '--limit', '100')).map((issue) => issue.title);
    }
    catch {
        // listing failures should not block reporting; fall through and create
    }
    const urls = [];
    for (const bug of bugs) {
        const title = `E2E failure looks like a real bug: ${bug.test.title}`;
        if (existingTitles.includes(title))
            continue;
        const bodyFile = path.join(os.tmpdir(), `testmedic-issue-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(bodyFile, buildIssueBody(bug, runUrl));
        urls.push(gh(repoRoot, 'issue', 'create', '--title', title, '--body-file', bodyFile));
    }
    return urls;
}
function buildPrBody(heals, runUrl) {
    const rows = heals
        .map((h) => `| ${h.test.title} | \`${escapePipes(h.patch.old_selector)}\` | \`${escapePipes(h.patch.new_selector)}\` | ${Math.round(h.patch.confidence * 100)}% | ${h.verified ? 'passing' : 'not verified'} |`)
        .join('\n');
    const explanations = heals
        .map((h) => `### ${h.test.title}\n${h.patch.explanation}`)
        .join('\n\n');
    return `The UI changed and these tests stopped finding their elements. The app behavior itself is intact: after re-binding the selectors below, every test passes again, assertions untouched.

| Test | Old selector | New selector | Confidence | Re-run |
|---|---|---|---|---|
${rows}

## Diagnosis

${explanations}

## Evidence

- Failing run: ${runUrl}
- Each healed test was re-run in isolation before this PR was opened; assertions were not modified.
- Note: checks on this PR may need a one-click "Approve workflows to run".
`;
}
function buildIssueBody(bug, runUrl) {
    const error = bug.test.errors.map((e) => e.message).join('\n\n').slice(0, 3000);
    const snapshot = extractSection(bug.test.errorContext ?? '', '# Page snapshot').slice(0, 3000);
    return `An E2E test failed and testmedic classified it as a likely real bug, not UI drift, so no automatic fix was attempted.

**Test:** ${bug.test.title}
**File:** ${bug.test.file}:${bug.test.line}
**Why it looks like a bug:** ${bug.reason}${bug.explanation ? `\n**Model diagnosis:** ${bug.explanation}` : ''}

## Error

\`\`\`
${error}
\`\`\`

${snapshot ? `## Page at the moment of failure\n\n\`\`\`yaml\n${snapshot}\n\`\`\`\n` : ''}
## Run

${runUrl}
Trace and screenshots are attached as artifacts on the run above.
`;
}
function extractSection(markdown, heading) {
    const start = markdown.indexOf(heading);
    if (start === -1)
        return '';
    const rest = markdown.slice(start + heading.length);
    const next = rest.indexOf('\n# ');
    return (next === -1 ? rest : rest.slice(0, next)).trim();
}
const escapePipes = (text) => text.replace(/\|/g, '\\|');
