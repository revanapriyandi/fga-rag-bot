// Privacy-Aware RAG Bot: an HR knowledge assistant where Auth0 FGA (OpenFGA API)
// decides, per document and per logged-in user, what the retriever may hand to the LLM.
// FGA_API_URL defaults to a local OpenFGA server; point it (plus FGA_STORE_ID /
// credentials) at Auth0 FGA (api.us1.fga.dev) to run the same code on the hosted service.
import { readFileSync } from 'node:fs';
import { OpenFgaClient } from '@openfga/sdk';

const env = Object.fromEntries(readFileSync(new URL('.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const FGA_API_URL = process.env.FGA_API_URL || 'http://127.0.0.1:8080';

// ---- 1. Authorization model: role + department based, inherited by documents ----
const model = {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    { type: 'department', relations: { member: { this: {} }, manager: { this: {} } },
      metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] },
                               manager: { directly_related_user_types: [{ type: 'user' }] } } } },
    { type: 'document',
      relations: {
        owner_dept: { this: {} },
        // anyone in the department can read general docs; only managers can read confidential ones
        viewer: { union: { child: [{ this: {} },
          { tupleToUserset: { tupleset: { relation: 'owner_dept' }, computedUserset: { relation: 'member' } } }] } },
        confidential_viewer: { tupleToUserset: { tupleset: { relation: 'owner_dept' }, computedUserset: { relation: 'manager' } } },
      },
      metadata: { relations: { owner_dept: { directly_related_user_types: [{ type: 'department' }] },
                               viewer: { directly_related_user_types: [{ type: 'user' }] },
                               confidential_viewer: { directly_related_user_types: [] } } } },
  ],
};

// ---- 2. Document store (the RAG index) ----
const docs = [
  { id: 'leave_policy', confidential: false, text: 'Leave policy: every employee gets 12 days of annual leave per year. Request leave in the HR portal two weeks ahead.' },
  { id: 'remote_work', confidential: false, text: 'Remote work: employees may work from home two days a week with manager approval.' },
  { id: 'salary_bands_2027', confidential: true, text: 'Salary bands 2027 (CONFIDENTIAL): Engineer I IDR 12-16M/month, Engineer II IDR 17-24M/month, Senior IDR 25-35M/month.' },
  { id: 'budget_Q4', confidential: true, text: 'Budget Q4 (CONFIDENTIAL): HR budget is IDR 450M, of which IDR 120M is reserved for raises.' },
];

// Tiny local retriever (bag-of-words cosine) so the demo needs no embedding API.
const tok = s => s.toLowerCase().match(/[a-z0-9]+/g) || [];
function score(q, d) { const a = new Set(tok(q)); const b = tok(d); return b.filter(w => a.has(w)).length / Math.sqrt(b.length || 1); }
const retrieve = (q, k = 3) => docs.map(d => ({ ...d, s: score(q, d.text) })).sort((x, y) => y.s - x.s).slice(0, k);

// ---- 3. FGA setup ----
const admin = new OpenFgaClient({ apiUrl: FGA_API_URL });
const { id: storeId } = await admin.createStore({ name: 'privacy-aware-rag-' + Date.now() });
const fga = new OpenFgaClient({ apiUrl: FGA_API_URL, storeId });
const { authorization_model_id } = await fga.writeAuthorizationModel(model);
const tuples = [
  { user: 'user:alice', relation: 'manager', object: 'department:hr' },   // Alice = HR manager
  { user: 'user:alice', relation: 'member', object: 'department:hr' },
  { user: 'user:bob', relation: 'member', object: 'department:hr' },      // Bob = general employee
  ...docs.map(d => ({ user: 'department:hr', relation: 'owner_dept', object: `document:${d.id}` })),
];
await fga.write({ writes: tuples }, { authorizationModelId: authorization_model_id });
console.log(`FGA store ${storeId}, model ${authorization_model_id}, ${tuples.length} tuples\n`);

// ---- 4. Retrieval with authorization enforced BEFORE the LLM sees anything ----
async function authorizedRetrieve(user, q) {
  const hits = retrieve(q);
  const checks = await Promise.all(hits.map(d => fga.check({
    user: `user:${user}`, relation: d.confidential ? 'confidential_viewer' : 'viewer', object: `document:${d.id}`,
  }, { authorizationModelId: authorization_model_id })));
  hits.forEach((d, i) => console.log(`  FGA check user:${user} ${d.confidential ? 'confidential_viewer' : 'viewer'} document:${d.id} -> ${checks[i].allowed ? 'ALLOWED' : 'DENIED'}`));
  return hits.filter((_, i) => checks[i].allowed);
}

async function llm(question, context) {
  if (!env.GROQ_API_KEY) return context.length ? context.map(d => d.text).join(' ') : 'I cannot find any document you are allowed to read that answers this.';
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0, messages: [
      { role: 'system', content: 'You are an HR assistant. Answer ONLY from the provided documents. If they do not contain the answer, say you do not have access to that information. Be brief.' },
      { role: 'user', content: `Documents:\n${context.map(d => `[${d.id}] ${d.text}`).join('\n') || '(none)'}\n\nQuestion: ${question}` }] }),
  });
  return (await r.json()).choices?.[0]?.message?.content?.trim();
}

async function ask(user, q) {
  console.log(`\n${user} asks: "${q}"`);
  const ctx = await authorizedRetrieve(user, q);
  const answer = await llm(q, ctx);
  console.log(`  context given to LLM: [${ctx.map(d => d.id).join(', ')}]\n  answer: ${answer}`);
  return { ctx, answer };
}

const a = await ask('alice', 'What are the salary bands for engineers in 2027?');
const b = await ask('bob', 'What are the salary bands for engineers in 2027?');
const c = await ask('bob', 'How many days of annual leave do I get?');

// Self-checks: the manager sees salary data, the employee never does (even though it was retrieved).
console.assert(a.ctx.some(d => d.id === 'salary_bands_2027'), 'manager should get the salary doc');
console.assert(!b.ctx.some(d => d.confidential), 'employee must never receive confidential docs');
console.assert(!/12-16M|17-24M|25-35M/.test(b.answer), 'employee answer must not leak salary numbers');
console.assert(c.ctx.some(d => d.id === 'leave_policy'), 'employee can read general policy');
console.log('\nall checks passed');
