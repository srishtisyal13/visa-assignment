/**
 * Pact-style consumer-driven contract verification (C3b).
 *
 * Each consumer publishes what it RELIES ON (consumers/*.pact.json). This tool
 * checks those expectations against a provider contract file, statically, in
 * the provider's CI before merge (the "can-i-deploy" question):
 *
 *   - the operation exists
 *   - headers the consumer sends are declared
 *   - the response status the consumer handles is documented
 *   - every field the consumer needs is declared, with the right type, and
 *     REQUIRED in the schema (else the provider may legally omit it)
 *   - enumerations the consumer switches on are closed and match
 *   - requests the consumer relies on being rejected are rejected by the schema
 *
 * Optional --live replays each interaction against a running target and checks
 * the actual response (provider verification, like `pact verify`).
 *
 *   npm run consumers:verify                          # vs published v1 contract
 *   npm run consumers:verify -- --contract contract/proposed/transactions-service.v1.1-proposed.yaml
 *   npm run consumers:verify -- --live http://127.0.0.1:4011
 *
 * In production this would be pact-js + a Pact Broker + can-i-deploy. This
 * file shows the same idea without a broker, so it runs offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ContractValidator } from '../../framework/contract/validator';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROOT = path.resolve(__dirname, '../..');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const contractFile = arg('--contract') ?? 'contract/transactions-service.v1.yaml';
const live = arg('--live');

const v = new ContractValidator(contractFile);

function responseSchema(op: Json, status: number): Json | undefined {
  const s = op.op.responses?.[String(status)]?.schema;
  if (!s) return undefined;
  const deref = (x: Json): Json => (x?.$ref ? deref(v.doc.definitions[x.$ref.split('/').pop()]) : x);
  return deref(s);
}

async function main() {
  const files = fs.readdirSync(path.join(ROOT, 'consumers')).filter((f) => f.endsWith('.pact.json'));
  let failures = 0;
  console.log(`Provider contract: ${contractFile}${live ? `  (live: ${live})` : ''}\n`);
  for (const f of files) {
    const pact = JSON.parse(fs.readFileSync(path.join(ROOT, 'consumers', f), 'utf8'));
    console.log(`== ${pact.consumer}`);
    for (const it of pact.interactions) {
      const problems: string[] = [];
      const op = v.findOperation(it.request.method, it.request.path);
      if (!op) {
        problems.push(`operation ${it.request.method} ${it.request.path} not in contract`);
      } else {
        const declared = v.declaredHeaders(it.request.method, it.request.path).map((h) => h.toLowerCase());
        for (const h of it.request.headers ?? []) if (!declared.includes(h.toLowerCase())) problems.push(`request header ${h} not declared`);
        if (!v.documentedStatuses(it.request.method, it.request.path).includes(it.response.status)) problems.push(`status ${it.response.status} not documented`);
        if (it.providerMustRejectRequest && it.request.body && v.validateRequestBody(it.request.method, it.request.path, it.request.body).length === 0) {
          problems.push('consumer relies on this request being rejected, but the request schema accepts it');
        }
        const schema = responseSchema(op, it.response.status);
        for (const [field, need] of Object.entries<Json>(it.response.fields ?? {})) {
          const prop = schema?.properties?.[field];
          if (!prop) { problems.push(`field ${field} not declared`); continue; }
          if (prop.type !== need.type) problems.push(`field ${field} is ${prop.type}, consumer needs ${need.type}`);
          if (need.required && !(schema.required ?? []).includes(field)) problems.push(`field ${field} is optional in contract, consumer requires it`);
          if (need.oneOf && !(Array.isArray(prop.enum) && prop.enum.every((e: unknown) => need.oneOf.includes(e)))) problems.push(`field ${field} has no closed enum ⊆ [${need.oneOf}]`);
          if (need.format && prop.format !== need.format) problems.push(`field ${field} has no format ${need.format}`);
        }
      }
      if (live) problems.push(...(await replay(it)));
      failures += problems.length ? 1 : 0;
      console.log(`  ${problems.length ? 'FAIL' : 'ok  '}  ${it.description}`);
      for (const p of problems) console.log(`          - ${p}`);
    }
    console.log('');
  }
  console.log(failures ? `${failures} interaction(s) cannot be honoured by this contract.` : 'All consumer expectations are honoured by this contract.');
  process.exit(failures ? 1 : 0);
}

async function replay(it: Json): Promise<string[]> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of it.request.headers ?? []) headers[h] = `pact-${Date.now()}-${Math.random()}`;
  const res = await fetch(live + it.request.path, { method: it.request.method, headers, body: it.request.body ? JSON.stringify(it.request.body) : undefined, signal: AbortSignal.timeout(5000) });
  const out: string[] = [];
  if (res.status !== it.response.status) out.push(`live: status ${res.status}, expected ${it.response.status}`);
  const body = await res.json().catch(() => undefined);
  for (const [field, need] of Object.entries<Json>(it.response.fields ?? {})) {
    const val = body?.[field];
    if (val === undefined) { if (need.required) out.push(`live: field ${field} missing`); continue; }
    const t = Array.isArray(val) ? 'array' : Number.isInteger(val) && need.type === 'integer' ? 'integer' : typeof val;
    if (t !== need.type && !(need.type === 'number' && typeof val === 'number')) out.push(`live: field ${field} is ${t}`);
  }
  return out;
}

main();
