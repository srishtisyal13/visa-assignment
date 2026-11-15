/**
 * THE SEAM.
 *
 * Every test talks to a "target". A target is a base URL plus a declared set of
 * capabilities. Tests never hard-code a host, a port, a header name or an
 * assumption about whether the server keeps state; they ask the target.
 *
 * Moving from the Prism mock to a real environment is a change of TARGET env var
 * (plus that environment's URL). No test file changes.
 *
 *   TARGET=mock     -> Prism serving the published v1 contract (default)
 *   TARGET=fake     -> the fault-injection fake (tools/fault-fake). Used ONLY to
 *                      prove tests can fail ("test the test"). See docs/C2.
 *   TARGET=<env>    -> a real deployed environment listed in environments.json
 *                      (staging, uat, preprod, ...). Adding one is a JSON entry,
 *                      not a code change. URL from <ENV>_URL or TARGET_URL.
 */
import fs from 'node:fs';
import path from 'node:path';

/** 'mock', 'fake', or the name of a deployed environment in environments.json. */
export type TargetName = string;

export interface Capabilities {
  /**
   * The server persists data and implements behaviour beyond the schema.
   * Prism is stateless and returns spec examples, so it is `false`. Any test
   * whose oracle is behaviour (sign, duplicates, idempotency, round-tripping)
   * must not run against a stateless target. If it did, it would pass or fail
   * by coincidence with the spec's example values (the "mock trap").
   */
  stateful: boolean;
  /** Name of the idempotency header. Hearsay H3 says one exists; its name is NOT in the contract. */
  idempotencyHeader: string;
  /** Name of the request-ID header. Hearsay H5; NOT in the contract. */
  requestIdHeader: string;
  /**
   * A read path that lists an account's transactions exists
   * (GET /accounts/{id}/transactions, the minimum contract change requested
   * in T1). The published v1 contract has NO such path.
   */
  transactionListing: boolean;
  /** Which contract file this target is expected to honour. */
  contractFile: string;
}

export interface Target {
  name: TargetName;
  baseURL: string;
  /** Base URL used by the T1 incident project (may differ on mock: see below). */
  incidentBaseURL: string;
  /** Capabilities of the incident base URL (may differ from the main one on mock). */
  incidentCapabilities: Capabilities;
  capabilities: Capabilities;
  requestTimeoutMs: number;
}

/** One entry of environments.json. Every field is optional; env vars override each one. */
export interface EnvironmentConfig {
  url?: string;
  /** CI runs the nightly suite and drift probe against environments with nightly: true. */
  nightly?: boolean;
  /** CI runs the nightly JMeter performance plan (T2) against environments with perf: true. */
  perf?: boolean;
  contractFile?: string;
  transactionListing?: boolean;
  idempotencyHeader?: string;
  requestIdHeader?: string;
  requestTimeoutMs?: number;
}

// An empty value counts as unset. CI passes `${{ vars.X }}` for every knob, and an
// undefined GitHub variable arrives as "", which must fall back to the default.
const env = (k: string, d?: string) => process.env[k] || d;
const bool = (k: string, d: boolean) => (!process.env[k] ? d : process.env[k] === 'true');

const ROOT = path.resolve(__dirname, '../..');
const PUBLISHED = 'contract/transactions-service.v1.yaml';
const PROPOSED = 'contract/proposed/transactions-service.v1.1-proposed.yaml';
const ENVIRONMENTS_FILE = 'framework/config/environments.json';

export const MOCK_PORT = Number(env('MOCK_PORT', '4010'));
export const MOCK_PROPOSED_PORT = Number(env('MOCK_PROPOSED_PORT', '4011'));
export const FAKE_PORT = Number(env('FAKE_PORT', '4020'));

/** Deployed environments, read from environments.json. */
export const ENVIRONMENTS: Record<string, EnvironmentConfig> =
  JSON.parse(fs.readFileSync(path.join(ROOT, ENVIRONMENTS_FILE), 'utf8')).environments ?? {};

export const KNOWN_TARGETS = ['mock', 'fake', ...Object.keys(ENVIRONMENTS)];

function deployed(name: string, cfg: EnvironmentConfig): Target {
  // "uat" -> UAT_URL, "pre-prod" -> PRE_PROD_URL. STAGING_URL keeps working for staging.
  const urlVar = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
  const url = env(urlVar) ?? env('TARGET_URL') ?? cfg.url;
  if (!url) {
    throw new Error(`TARGET=${name} needs a base URL: set ${urlVar} (or TARGET_URL), or add "url" to its entry in ${ENVIRONMENTS_FILE}.`);
  }
  // Defaults describe the PUBLISHED contract. Flip them only when the provider has
  // actually shipped the capability; the T1 test then starts enforcing instead of
  // reporting "not verifiable". Set transactionListing (CAP_TRANSACTION_LISTING)
  // together with contractFile (CONTRACT_FILE) pointing at the contract that
  // declares the read path; with the flag alone, the automatic contract gate
  // rejects GET /accounts/{id}/transactions as undeclared.
  const caps: Capabilities = {
    stateful: true,
    idempotencyHeader: env('IDEMPOTENCY_HEADER', cfg.idempotencyHeader ?? 'Idempotency-Key')!,
    requestIdHeader: env('REQUEST_ID_HEADER', cfg.requestIdHeader ?? 'X-Request-Id')!,
    transactionListing: bool('CAP_TRANSACTION_LISTING', cfg.transactionListing ?? false),
    contractFile: env('CONTRACT_FILE', cfg.contractFile ?? PUBLISHED)!,
  };
  if (!fs.existsSync(path.join(ROOT, caps.contractFile))) {
    throw new Error(`TARGET=${name}: contract file "${caps.contractFile}" not found (from CONTRACT_FILE or ${ENVIRONMENTS_FILE}).`);
  }
  const requestTimeoutMs = Number(env('REQUEST_TIMEOUT_MS', String(cfg.requestTimeoutMs ?? 10_000)));
  return { name, baseURL: url, incidentBaseURL: url, incidentCapabilities: caps, capabilities: caps, requestTimeoutMs };
}

function build(name: TargetName): Target {
  if (name === 'mock') {
    const caps: Capabilities = {
      stateful: false,
      idempotencyHeader: 'Idempotency-Key',
      requestIdHeader: 'X-Request-Id',
      transactionListing: false,
      contractFile: PUBLISHED,
    };
    return {
      name,
      baseURL: `http://127.0.0.1:${MOCK_PORT}`,
      // On the mock, T1 runs against a second Prism instance serving the
      // PROPOSED contract, because the published one has no way to count.
      incidentBaseURL: `http://127.0.0.1:${MOCK_PROPOSED_PORT}`,
      incidentCapabilities: { ...caps, transactionListing: true, contractFile: PROPOSED },
      capabilities: caps,
      requestTimeoutMs: 5_000,
    };
  }
  if (name === 'fake') {
    const caps: Capabilities = {
      stateful: true,
      idempotencyHeader: 'Idempotency-Key',
      requestIdHeader: 'X-Request-Id',
      transactionListing: true,
      contractFile: PROPOSED,
    };
    const url = `http://127.0.0.1:${FAKE_PORT}`;
    return { name, baseURL: url, incidentBaseURL: url, incidentCapabilities: caps, capabilities: caps, requestTimeoutMs: 5_000 };
  }
  const cfg = ENVIRONMENTS[name];
  if (cfg) return deployed(name, cfg);
  throw new Error(
    `Unknown TARGET "${name}". Known targets: ${KNOWN_TARGETS.join(', ')}. ` +
      `To add a deployed environment, add an entry to ${ENVIRONMENTS_FILE} (no code change).`,
  );
}

export const TARGET: Target = build(env('TARGET', 'mock')!);
