const combinedMessage = (test) => test.errors.map((e) => e.message).join('\n\n');
/**
 * Deterministic gate deciding whether a failure is a candidate for healing.
 * The rules err on the side of "real bug": healing a genuine regression away
 * would be the worst possible outcome, so anything the rules cannot place
 * confidently lands in real-bug or ambiguous, never in healable.
 */
export function classify(test) {
    const msg = combinedMessage(test);
    if (/net::ERR_|ERR_CONNECTION|page crashed|browser has been closed/i.test(msg)) {
        return { category: 'real-bug', reason: 'Network error or crash during the test' };
    }
    const elementWasFound = /locator resolved to/.test(msg);
    const valueMismatch = /Expected(:| string| pattern)/.test(msg) && /Received/.test(msg);
    if (elementWasFound && valueMismatch) {
        return {
            category: 'real-bug',
            reason: 'Element was found; its value or state did not match the assertion',
        };
    }
    if (/strict mode violation/.test(msg)) {
        return healableIfSnapshot(test, 'Selector matches multiple elements (strict mode violation)');
    }
    const waitingForLocator = /waiting for (locator|getBy|frameLocator)/.test(msg);
    if (waitingForLocator && !elementWasFound) {
        return healableIfSnapshot(test, 'Element never resolved: selector no longer matches the page');
    }
    if (/Test timeout of \d+ms exceeded/.test(msg) && !waitingForLocator) {
        return {
            category: 'infra',
            reason: 'Test timed out with no locator context (possible hang or slow environment)',
        };
    }
    return { category: 'ambiguous', reason: 'No deterministic rule matched' };
}
function healableIfSnapshot(test, reason) {
    if (!test.errorContext || !test.errorContext.includes('# Page snapshot')) {
        return {
            category: 'real-bug',
            reason: `${reason}, but no page snapshot is available to heal from`,
        };
    }
    return { category: 'healable', reason };
}
