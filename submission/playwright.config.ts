import { defineConfig } from '@playwright/test';
import { TARGET, MOCK_PORT, MOCK_PROPOSED_PORT, FAKE_PORT } from './framework/config/targets';
import type { ProjectOptions } from './framework/fixtures';

const CI = !!process.env.CI;
// One run id for the whole run: workers inherit it, so test data and manifests from one run share a namespace.
process.env.RUN_ID ??= String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

/** Servers are started only for local, contract-derived targets. Staging is never started by us. */
const webServer =
  TARGET.name === 'mock'
    ? [
        {
          command: `npx prism mock -p ${MOCK_PORT} -h 127.0.0.1 contract/transactions-service.v1.yaml`,
          url: `http://127.0.0.1:${MOCK_PORT}/accounts/1`,
          reuseExistingServer: !CI,
          timeout: 60_000,
        },
        {
          command: `npx prism mock -p ${MOCK_PROPOSED_PORT} -h 127.0.0.1 contract/proposed/transactions-service.v1.1-proposed.yaml`,
          url: `http://127.0.0.1:${MOCK_PROPOSED_PORT}/accounts/1`,
          reuseExistingServer: !CI,
          timeout: 60_000,
        },
      ]
    : TARGET.name === 'fake'
      ? [
          {
            command: `npx tsx tools/fault-fake/server.ts`,
            url: `http://127.0.0.1:${FAKE_PORT}/accounts/abc`,
            reuseExistingServer: !CI && !!process.env.REUSE_FAKE,
            timeout: 30_000,
            env: { PORT: String(FAKE_PORT), FAULTS: process.env.FAULTS ?? '' },
          },
        ]
      : undefined;

export default defineConfig<ProjectOptions>({
  testDir: './tests',
  fullyParallel: true,
  workers: process.env.WORKERS ? Number(process.env.WORKERS) : CI ? 4 : undefined,
  // Flake policy (docs/C2 §4): a retry is a diagnostic, never a pass. One retry in
  // CI captures a trace, and failOnFlakyTests turns "passed on retry" into a red build.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  forbidOnly: CI,
  timeout: 30_000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'reports/html' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
  ],
  outputDir: 'reports/artifacts',
  use: { trace: 'retain-on-failure' },
  webServer,
  metadata: { target: TARGET.name, baseURL: TARGET.baseURL, capabilities: TARGET.capabilities },
  projects: [
    { name: 'unit', testDir: './tests/unit' },
    { name: 'contract', testDir: './tests/contract' },
    { name: 'functional', testDir: './tests/functional' },
    { name: 'incident', testDir: './tests/incident', use: { incident: true } },
    { name: 'e2e', testDir: './tests/e2e' },
    { name: 'generated', testDir: './tests/generated' },
  ],
});
