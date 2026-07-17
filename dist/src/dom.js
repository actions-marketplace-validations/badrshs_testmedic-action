import fs from 'node:fs';
import path from 'node:path';
/**
 * The aria snapshot Playwright attaches to failures contains roles and
 * accessible names but no element ids, so an id-to-id rename is invisible to
 * the healer. This module fetches the pages the failing test visits and
 * builds a compact digest of the real markup (every tag carrying an id or
 * name, all form controls) to give the model DOM-level evidence.
 */
const MAX_PATHS = 3;
const MAX_TAG_LENGTH = 300;
const MAX_DIGEST_BYTES = 8000;
const FETCH_TIMEOUT_MS = 10_000;
export function extractGotoPaths(testSource) {
    const paths = new Set();
    const pattern = /\.goto\(\s*['"`]([^'"`)]+)['"`]/g;
    let match;
    while ((match = pattern.exec(testSource)) !== null) {
        paths.add(match[1]);
        if (paths.size >= MAX_PATHS)
            break;
    }
    return [...paths];
}
export function detectBaseUrl(workingDirectory) {
    const fromEnv = process.env.TM_BASE_URL?.trim();
    if (fromEnv)
        return fromEnv;
    for (const name of [
        'playwright.config.ts',
        'playwright.config.js',
        'playwright.config.mjs',
        'playwright.config.cjs',
    ]) {
        const configPath = path.join(workingDirectory, name);
        if (!fs.existsSync(configPath))
            continue;
        const source = fs.readFileSync(configPath, 'utf8');
        const match = source.match(/baseURL[^\n]*?['"`](https?:\/\/[^'"`]+)['"`]/);
        if (match)
            return match[1];
    }
    return undefined;
}
export function buildDomDigest(html, maxBytes = MAX_DIGEST_BYTES) {
    // Plain links add nothing the aria snapshot lacks; keep form controls and
    // anything carrying an id (the piece of evidence aria snapshots omit).
    const interesting = /<(?:form|select|input|button|textarea|label)\b[^>]*>|<[a-z][a-z0-9-]*\b[^>]*\bid\s*=\s*["'][^"']+["'][^>]*>/gi;
    const seen = new Set();
    const lines = [];
    let size = 0;
    let match;
    while ((match = interesting.exec(html)) !== null) {
        let tag = match[0].replace(/\s+/g, ' ').trim();
        if (tag.length > MAX_TAG_LENGTH)
            tag = `${tag.slice(0, MAX_TAG_LENGTH)}...>`;
        if (seen.has(tag))
            continue;
        seen.add(tag);
        size += tag.length + 1;
        if (size > maxBytes) {
            lines.push('(digest truncated)');
            break;
        }
        lines.push(tag);
    }
    return lines.join('\n');
}
export async function fetchDomDigest(baseUrl, paths, log) {
    const sections = [];
    for (const targetPath of paths.slice(0, MAX_PATHS)) {
        const url = targetPath.startsWith('http')
            ? targetPath
            : new URL(targetPath, baseUrl).toString();
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { accept: 'text/html', 'user-agent': 'testmedic-healer' },
            });
            clearTimeout(timer);
            if (!response.ok) {
                log(`  dom digest: ${url} returned ${response.status}, skipping`);
                continue;
            }
            const digest = buildDomDigest(await response.text());
            if (digest)
                sections.push(`--- ${url}\n${digest}`);
        }
        catch (error) {
            log(`  dom digest: could not fetch ${url} (${error?.message ?? error})`);
        }
    }
    return sections.length > 0 ? sections.join('\n\n') : undefined;
}
