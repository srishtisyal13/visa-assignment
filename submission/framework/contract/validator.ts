/**
 * Schema-driven contract validation layer (C3b).
 *
 * Loads the Swagger 2.0 contract and checks any observed HTTP exchange
 * against it. Nothing about the API is hand-written here: operations, documented
 * status codes, media types and body schemas are all read from the YAML, so
 * a contract change changes the validator with no code edit.
 *
 * Two strictness levels:
 *   - 'contract' : exactly what the YAML says (documented status, produces, schema)
 *   - 'strict'   : additionally forbids undeclared response properties. The
 *                  contract is SILENT on additionalProperties, so this level is
 *                  an ASSUMPTION used for drift detection, not a contract verdict.
 */
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Exchange {
  method: string;
  /** Concrete path, e.g. /accounts/42 (query string allowed). */
  path: string;
  status: number;
  contentType?: string;
  body: unknown;
}

export interface Violation {
  /** Where in the contract the rule comes from (JSON pointer into the YAML). */
  contractAnchor: string;
  rule: 'unknown-operation' | 'undocumented-status' | 'media-type' | 'schema' | 'missing-header';
  message: string;
}

export type Strictness = 'contract' | 'strict';

interface Operation {
  method: string;
  template: string;
  regex: RegExp;
  op: Json;
}

const ROOT = path.resolve(__dirname, '../..');

export class ContractValidator {
  readonly doc: Json;
  private readonly ajv: Ajv;
  private readonly ops: Operation[];

  constructor(readonly contractFile: string) {
    const abs = path.isAbsolute(contractFile) ? contractFile : path.join(ROOT, contractFile);
    this.doc = yaml.load(fs.readFileSync(abs, 'utf8')) as Json;
    if (this.doc.swagger !== '2.0') throw new Error(`Only Swagger 2.0 supported, got ${this.doc.swagger}`);
    // Swagger 2.0 schemas are a JSON-Schema draft-4 dialect; `example` and
    // `x-*` are annotations Ajv must tolerate, not validate.
    this.ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ops = [];
    for (const [template, item] of Object.entries<Json>(this.doc.paths ?? {})) {
      for (const [method, op] of Object.entries<Json>(item)) {
        if (method === 'parameters') continue;
        const regex = new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$');
        this.ops.push({ method: method.toUpperCase(), template, regex, op });
      }
    }
  }

  /** All (method, path-template) pairs the contract declares. */
  operations(): { method: string; template: string; op: Json }[] {
    return this.ops.map(({ method, template, op }) => ({ method, template, op }));
  }

  findOperation(method: string, concretePath: string): Operation | undefined {
    const p = concretePath.split('?')[0];
    return this.ops.find((o) => o.method === method.toUpperCase() && o.regex.test(p));
  }

  documentedStatuses(method: string, concretePath: string): number[] {
    const op = this.findOperation(method, concretePath);
    return op ? Object.keys(op.op.responses ?? {}).filter((k) => /^\d+$/.test(k)).map(Number) : [];
  }

  /** Validate a response against the contract. Returns [] when conformant. */
  validateResponse(x: Exchange, strictness: Strictness = 'contract'): Violation[] {
    const op = this.findOperation(x.method, x.path);
    if (!op) {
      // 405 on a known path for an undeclared method: the contract declares 405
      // under each operation, so validate the body against the sibling's 405 schema.
      const sibling = this.ops.find((o) => o.regex.test(x.path.split('?')[0]) && o.op.responses?.['405']);
      if (x.status === 405 && sibling) return this.checkBody(sibling, '405', x, strictness);
      return [{ contractAnchor: '#/paths', rule: 'unknown-operation', message: `${x.method} ${x.path} is not declared in the contract` }];
    }
    const key = String(x.status);
    const anchorBase = `#/paths/${escapePtr(op.template)}/${op.method.toLowerCase()}`;
    const resp = op.op.responses?.[key] ?? op.op.responses?.default;
    if (!resp) {
      return [{
        contractAnchor: `${anchorBase}/responses`,
        rule: 'undocumented-status',
        message: `status ${x.status} not documented (documented: ${Object.keys(op.op.responses ?? {}).join(', ')})`,
      }];
    }
    return this.checkBody(op, key, x, strictness);
  }

  private checkBody(op: Operation, key: string, x: Exchange, strictness: Strictness): Violation[] {
    const out: Violation[] = [];
    const anchorBase = `#/paths/${escapePtr(op.template)}/${op.method.toLowerCase()}`;
    const produces: string[] = op.op.produces ?? this.doc.produces ?? [];
    const resp = op.op.responses[key];
    if (resp?.schema) {
      const ct = (x.contentType ?? '').split(';')[0].trim().toLowerCase();
      if (produces.length && !produces.includes(ct)) {
        out.push({ contractAnchor: `${anchorBase}/produces`, rule: 'media-type', message: `content-type "${ct || '<none>'}" not in produces [${produces.join(', ')}]` });
      }
      const schema = this.resolveForAjv(resp.schema, strictness);
      const validate = this.ajv.compile(schema);
      if (!validate(x.body)) {
        out.push(...(validate.errors ?? []).map((e) => toViolation(e, `${anchorBase}/responses/${key}/schema`)));
      }
    }
    return out;
  }

  /** Validate a request body we are about to send (guards against authoring mistakes). */
  validateRequestBody(method: string, concretePath: string, body: unknown): Violation[] {
    const op = this.findOperation(method, concretePath);
    const param = op ? this.params(op).find((p: Json) => p.in === 'body') : undefined;
    if (!op || !param?.schema) return [];
    const validate = this.ajv.compile(this.resolveForAjv(param.schema, 'contract'));
    return validate(body) ? [] : (validate.errors ?? []).map((e) => toViolation(e, `#/paths/${escapePtr(op.template)}/${op.method.toLowerCase()}/parameters`));
  }

  /** Header parameters the contract declares for an operation (v1: none). */
  declaredHeaders(method: string, concretePath: string): string[] {
    const op = this.findOperation(method, concretePath);
    return op ? this.params(op).filter((p: Json) => p.in === 'header').map((p: Json) => p.name) : [];
  }

  /** Operation parameters with `$ref: '#/parameters/X'` resolved (Swagger 2.0 shared parameters). */
  private params(op: Operation): Json[] {
    return (op.op.parameters ?? []).map((p: Json) =>
      typeof p.$ref === 'string' && p.$ref.startsWith('#/parameters/') ? this.doc.parameters[p.$ref.slice('#/parameters/'.length)] : p,
    );
  }

  private resolveForAjv(schema: Json, strictness: Strictness): Json {
    const rewrite = (s: Json): Json => {
      if (Array.isArray(s)) return s.map(rewrite);
      if (s && typeof s === 'object') {
        if (typeof s.$ref === 'string' && s.$ref.startsWith('#/definitions/')) {
          const name = s.$ref.slice('#/definitions/'.length);
          return rewrite(structuredClone(this.doc.definitions[name]));
        }
        const o: Json = {};
        for (const [k, v] of Object.entries(s)) o[k] = rewrite(v);
        // Swagger 2.0 = JSON Schema draft-4: exclusiveMinimum/Maximum are BOOLEAN
        // modifiers of minimum/maximum. Ajv speaks draft-07 (numeric form). Translate.
        if (o.exclusiveMinimum === true && typeof o.minimum === 'number') { o.exclusiveMinimum = o.minimum; delete o.minimum; }
        else if (o.exclusiveMinimum === false) delete o.exclusiveMinimum;
        if (o.exclusiveMaximum === true && typeof o.maximum === 'number') { o.exclusiveMaximum = o.maximum; delete o.maximum; }
        else if (o.exclusiveMaximum === false) delete o.exclusiveMaximum;
        if (strictness === 'strict' && o.type === 'object' && o.properties && o.additionalProperties === undefined) {
          o.additionalProperties = false;
        }
        return o;
      }
      return s;
    };
    return rewrite(schema);
  }
}

function escapePtr(s: string) {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function toViolation(e: ErrorObject, anchor: string): Violation {
  return { contractAnchor: anchor, rule: 'schema', message: `${e.instancePath || '(root)'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}` };
}

const cache = new Map<string, ContractValidator>();
export function validatorFor(contractFile: string): ContractValidator {
  let v = cache.get(contractFile);
  if (!v) cache.set(contractFile, (v = new ContractValidator(contractFile)));
  return v;
}
