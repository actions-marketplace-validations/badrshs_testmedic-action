# testmedic

**Self-healing E2E tests. Dependabot, but for your Playwright suite.**

Your UI changed, a selector died, and CI went red even though nothing is actually broken. testmedic wakes up when your Playwright tests fail, investigates like an engineer would, and then either:

- opens a **pull request** that repairs the selector, with evidence the app behavior is intact (the healed test is re-run in isolation and passes before the PR is opened), or
- opens an **issue** saying "this is a real bug, do not touch the test", with the error, the page state at the moment of failure, and a link to the run.

No AI runs inside your tests. Your suite stays plain, deterministic Playwright. The AI only wakes up on failure and reads the evidence Playwright already produced.

## Quickstart

```yaml
name: e2e

on:
  push:
    branches-ignore:
      - 'heal/**'
  pull_request:

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install and run tests
        id: e2e
        continue-on-error: true
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npx playwright test

      - name: Heal or report
        if: steps.e2e.outcome == 'failure'
        uses: badrshs/testmedic-action@v1
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # or: anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Fail the job if tests failed
        if: steps.e2e.outcome == 'failure'
        run: exit 1
```

## Requirements

- Playwright 1.53+ with the JSON reporter:
  `reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]]`
- Job permissions as in the example above.
- **Repository setting (the most common setup mistake):** Settings -> Actions -> General -> enable "Allow GitHub Actions to create and approve pull requests".
- An AI credential in repo secrets: `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription, generate with `claude setup-token`) or `ANTHROPIC_API_KEY`.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `claude-code-oauth-token` | | Claude subscription token (this or `anthropic-api-key`) |
| `anthropic-api-key` | | Anthropic API key (this or the OAuth token) |
| `model` | `claude-sonnet-5` | Model used for diagnosis and repair |
| `mode` | `heal` | `heal`, `dry-run` (log only), or `issue-only` (never patch) |
| `max-heals` | `3` | Max tests healed per run (cost cap) |
| `min-confidence` | `0.6` | Below this the heal is not applied |
| `report` | `test-results/results.json` | Playwright JSON report path |
| `working-directory` | `.` | Playwright project directory |
| `test-command` | `npx playwright test` | Command for verification re-runs |

## Outputs

| Output | Meaning |
|---|---|
| `pr-url` | URL of the heal pull request, if opened |
| `issue-urls` | Comma-separated bug issue URLs |
| `healed-count` | Number of tests healed and verified |

## How it decides "UI drift" vs "real bug"

1. A deterministic classifier runs first, no AI involved. Element found but with the wrong value, network errors, crashes: real bug, never healed. Element that never resolved while the page snapshot shows the feature intact: healing candidate. Bare timeouts: infra noise, logged only.
2. The model diagnoses candidates from the page snapshot Playwright captured at the moment of failure. It repairs locators only, never assertions, and is instructed to default to "no".
3. Every heal is verified: the repaired test is re-run in isolation and must pass before a PR is opened. If it still fails, the patch is reverted and you get an issue instead. "UI drift" has an operational definition here: after re-binding the selector, every behavioral assertion still passes.

## Safety

- Heals arrive as PRs on `heal/*` branches for human review. testmedic never pushes to your main branch.
- Heal PRs never trigger new healing (branch filters, runtime guards, and GitHub token semantics), so no loops.
- `max-heals` caps AI spend per run. Typical heal cost is a few cents or less.
