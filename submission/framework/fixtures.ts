/**
 * Playwright fixtures: the only thing a test author imports.
 *
 *   import { test, expect } from '../../framework/fixtures';
 *   test('…', async ({ api, data, caps }) => { … });
 *
 * Provided:
 *   api       TransactionsClient bound to the current target
 *   caps      the target's declared capabilities
 *   data      namespaced test-data factory
 *   ledger    records created resources (teardown manifest)
 *   account   a fresh account created for this test (lazy: only if requested)
 *   contract  the ContractValidator for the target's contract
 *
 * Helper: allowContractViolation(api, reason) opts one test out of the automatic contract gate.
 */
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TARGET, type Capabilities } from './config/targets';
import { TransactionsClient, type ApiResult } from './client/transactions-client';
import { ContractValidator, validatorFor } from './contract/validator';
import { DataFactory, ResourceLedger, RUN_ID } from './data/test-data';

interface Fixtures {
  caps: Capabilities;
  contract: ContractValidator;
  api: TransactionsClient;
  data: DataFactory;
  ledger: ResourceLedger;
  account: { account_id: number; document_number: string };
}

interface WorkerFixtures {
  workerData: DataFactory;
}

/** Projects set `incident: true` to run against the incident base URL (see targets.ts). */
export interface ProjectOptions { incident: boolean }

export const test = base.extend<Fixtures & ProjectOptions, WorkerFixtures>({
  incident: [false, { option: true }],

  workerData: [async ({}, use, workerInfo) => { // eslint-disable-line no-empty-pattern
    await use(new DataFactory(workerInfo.workerIndex, workerInfo.config.shard?.current ?? 0));
  }, { scope: 'worker' }],

  caps: async ({ incident }, use) => {
    await use(incident ? TARGET.incidentCapabilities : TARGET.capabilities);
  },

  contract: async ({ caps }, use) => {
    await use(validatorFor(caps.contractFile));
  },

  data: async ({ workerData }, use) => use(workerData),

  ledger: async ({}, use, testInfo) => { // eslint-disable-line no-empty-pattern
    const ledger = new ResourceLedger(testInfo.titlePath.join(' > '));
    await use(ledger);
    // Teardown: the API has no DELETE (contract finding CF-11), so persist a
    // manifest for the out-of-band janitor rather than pretending to clean up.
    if (ledger.items.length) {
      const file = path.join(testInfo.project.outputDir, '..', 'created-resources', `${RUN_ID}-w${testInfo.workerIndex}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, ledger.items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }
  },

  api: async ({ playwright, caps, contract, ledger, incident }, use, testInfo) => {
    const exchanges: ApiResult[] = [];
    let optOut: string | undefined;
    const ctx = await playwright.request.newContext({
      baseURL: incident ? TARGET.incidentBaseURL : TARGET.baseURL,
      extraHTTPHeaders: { 'x-qa-run-id': RUN_ID },
    });
    const client = new TransactionsClient(ctx, caps, contract, (r) => {
      exchanges.push(r);
      if (r.status === 201 && r.body && typeof r.body === 'object') {
        const b = r.body as Record<string, unknown>;
        if (r.path === '/accounts' && 'account_id' in b) ledger.record('account', b.account_id);
        if (r.path === '/transactions' && 'transaction_id' in b) ledger.record('transaction', b.transaction_id);
      }
    }, TARGET.requestTimeoutMs);
    (client as unknown as { allowContractViolation: (r: string) => void }).allowContractViolation = (r: string) => { optOut = r; };
    await use(client);
    await ctx.dispose();

    // Automatic contract gate: any response that violates the contract fails
    // the test, unless the test explicitly opted out with a reason.
    const violations = exchanges.flatMap((e) => e.violations.map((v) => `${e.method} ${e.path} -> ${e.status}: [${v.rule}] ${v.message} (${v.contractAnchor})`));
    if (violations.length) {
      await testInfo.attach('contract-violations', { body: violations.join('\n'), contentType: 'text/plain' });
    }
    if (optOut) {
      testInfo.annotations.push({ type: 'contract-gate', description: `opted out: ${optOut}` });
    } else if (testInfo.status === testInfo.expectedStatus) {
      expect(violations, 'responses must conform to the contract (automatic gate)').toEqual([]);
    }
  },

  account: async ({ api, data, caps }, use) => {
    const doc = data.documentNumber();
    const res = await api.createAccount(doc);
    expect(res.status, `fixture: create account ${doc}`).toBe(201);
    const body = res.body as { account_id: number; document_number: string };
    // On a stateless mock the id is the spec example; on real targets it is ours.
    await use({ account_id: body.account_id, document_number: caps.stateful ? doc : body.document_number });
  },
});

/** Opt the current test out of the automatic contract gate (with a reason that lands in the report). */
export function allowContractViolation(api: TransactionsClient, reason: string) {
  (api as unknown as { allowContractViolation: (r: string) => void }).allowContractViolation(reason);
}

export { expect };
