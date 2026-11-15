/**
 * Known places where the Prism mock does NOT honour the contract it was
 * generated from. Each one was observed by probing the mock (see docs/C3b §4).
 *
 * A test that hits one is marked "expected to fail" ON THE MOCK ONLY, using
 * test.fail() (today only MOCK-1 affects an assertion: the four CT-20 tests). If Prism is upgraded and the divergence disappears, the test
 * flips to "unexpectedly passed" and the build tells us to delete the entry.
 * The register therefore cannot silently go stale. On staging these
 * tests run as normal assertions.
 */
import { test } from '@playwright/test';
import { TARGET } from './config/targets';

export const MOCK_DIVERGENCES = {
  'MOCK-1': '405 responses are application/problem+json, not handler.errorResponse / application/json as the contract declares (#/paths/*/responses/405).',
  'MOCK-2': 'Malformed JSON body: Prism never answers some clients (curl and Node fetch hang until timeout), which no declared response allows. Playwright\'s client gets documented statuses (400 on POST /accounts, 422 on POST /transactions), so no test is marked for it.',
  'MOCK-3': 'Every error response body is the spec example {"error":"account not found"}, whatever the actual error.',
} as const;

export function knownMockDivergence(id: keyof typeof MOCK_DIVERGENCES) {
  test.fail(TARGET.name === 'mock', `${id}: ${MOCK_DIVERGENCES[id]}`);
}
