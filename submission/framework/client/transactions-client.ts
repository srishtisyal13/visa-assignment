/**
 * Service abstraction over Playwright's APIRequestContext.
 *
 * Tests speak in domain verbs (createAccount, createTransaction) instead of
 * URLs. Every response passes through the contract validator automatically, so
 * an engineer adding a test gets contract checking for free and cannot forget it.
 */
import type { APIRequestContext } from '@playwright/test';
import type { Capabilities } from '../config/targets';
import { ContractValidator, type Violation } from '../contract/validator';

export interface ApiResult<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: T;
  text: string;
  violations: Violation[];
}

export interface RawRequest {
  method: string;
  path: string;
  /** Object -> JSON-encoded. String/Buffer -> sent verbatim (malformed JSON, oversized bodies). */
  data?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CreateTransactionBody {
  account_id: unknown;
  operation_type_id: unknown;
  amount: unknown;
}

/** Receives every exchange; the fixture uses it to fail tests on unexpected contract violations. */
export type ExchangeObserver = (r: ApiResult) => void;

export class TransactionsClient {
  constructor(
    private readonly ctx: APIRequestContext,
    readonly caps: Capabilities,
    readonly contract: ContractValidator,
    private readonly observe: ExchangeObserver = () => {},
    private readonly defaultTimeoutMs = 5_000,
  ) {}

  createAccount(document_number: unknown, headers?: Record<string, string>) {
    return this.raw({ method: 'POST', path: '/accounts', data: { document_number }, headers });
  }

  getAccount(accountId: number | string) {
    return this.raw({ method: 'GET', path: `/accounts/${accountId}` });
  }

  /**
   * idempotencyKey: string -> header sent; null -> header deliberately omitted.
   * The header NAME comes from the target (it is not in the v1 contract).
   */
  createTransaction(body: CreateTransactionBody | Record<string, unknown>, opts: { idempotencyKey?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.idempotencyKey) headers[this.caps.idempotencyHeader] = opts.idempotencyKey;
    return this.raw({ method: 'POST', path: '/transactions', data: body, headers });
  }

  /** Proposed contract only (T1 minimum change). Throws if the target cannot list. */
  listTransactions(accountId: number, query: Record<string, string> = {}) {
    if (!this.caps.transactionListing) {
      throw new NotObservableError(
        'GET /accounts/{accountId}/transactions does not exist in the published contract; transaction count is not observable through the API.',
      );
    }
    const qs = new URLSearchParams(query).toString();
    return this.raw({ method: 'GET', path: `/accounts/${accountId}/transactions${qs ? '?' + qs : ''}` });
  }

  async raw(req: RawRequest): Promise<ApiResult> {
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    let data: string | Buffer | undefined;
    if (req.data === undefined) data = undefined;
    else if (typeof req.data === 'string' || Buffer.isBuffer(req.data)) data = req.data;
    else data = JSON.stringify(req.data);
    if (data !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const res = await this.ctx.fetch(req.path, {
      method: req.method,
      headers,
      data,
      timeout: req.timeoutMs ?? this.defaultTimeoutMs,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body kept as text */ }
    const resHeaders = res.headers();
    const result: ApiResult = {
      method: req.method,
      path: req.path,
      status: res.status(),
      headers: resHeaders,
      body,
      text,
      violations: [],
    };
    result.violations = this.contract.validateResponse({
      method: req.method, path: req.path, status: result.status, contentType: resHeaders['content-type'], body,
    });
    this.observe(result);
    return result;
  }
}

export class NotObservableError extends Error {
  readonly name = 'NotObservableError';
}
