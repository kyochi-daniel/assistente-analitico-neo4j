import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { buildSalesGraph } from '../src/graph/graph.ts';
import { createServer } from '../src/server.ts';
import { Neo4jService } from '../src/services/neo4jService.ts';
import { assertReadOnlyCypher } from '../src/services/cypherSafety.ts';
import type { OpenRouterService } from '../src/services/openrouterService.ts';
import type { Driver } from 'neo4j-driver';
import config from '../src/config.ts';
import { seedDatabase } from '../data/seedHelpers.ts';

function fakeLLM(responses: any[]) {
  const prompts: any[] = [];
  let index = 0;
  const llm = {
    async generateStructured(system: string, user: string, schema: any) {
      prompts.push({ system, user });
      const response = responses[index++];
      if (!response) throw new Error('Chamada LLM inesperada');
      return response.error ? response : { data: schema.parse(response) };
    },
  } as unknown as OpenRouterService;
  return { llm, prompts };
}
const simplePlan = { complexity: 'simple', requiresDecomposition: false, subQuestions: [], reasoning: 'Teste' };
const multiPlan = { complexity: 'complex', requiresDecomposition: true, subQuestions: ['Primeira etapa?', 'Segunda etapa?'], reasoning: 'Teste' };
const answer = { answer: 'Síntese das etapas.', followUpQuestions: [] };
const generated = (query = 'MATCH (c:Course) RETURN c.name') => ({ query, explanation: 'Teste' });

function database(results: any[]) {
  let index = 0;
  const queries: string[] = [];
  return {
    queries,
    service: {
      getSchema: async () => 'Course {name}',
      query: async (query: string) => {
        queries.push(query);
        const result = results[index++];
        if (result instanceof Error) throw result;
        return result;
      },
      close: async () => {},
    } as unknown as Neo4jService,
  };
}
const invoke = (graph: ReturnType<typeof buildSalesGraph>) => graph.invoke({ messages: [new HumanMessage('Compare os cursos')] });

describe('Grafo offline', () => {
  for (const results of [[[ { value: 1 }, { value: 2 } ], []], [[], [{ value: 3 }]], [[], []]]) {
    it(`preserva duas etapas e sintetiza inclusive conjuntos vazios: ${JSON.stringify(results)}`, async () => {
      const { llm, prompts } = fakeLLM([multiPlan, generated(), generated('MATCH (s:Student) RETURN count(s)'), answer]);
      const db = database(results);
      const result = await invoke(buildSalesGraph(llm, db.service));
      assert.equal(result.error, undefined);
      assert.equal(result.currentStep, 2);
      assert.deepEqual(result.subResults, results);
      assert.deepEqual(result.subQueries, db.queries);
      const synthesis = JSON.parse(prompts.at(-1).user);
      assert.deepEqual(synthesis.steps.map((step: any) => JSON.parse(step.results)), results);
      assert.deepEqual(synthesis.steps.map((step: any) => step.question), multiPlan.subQuestions);
      assert.equal(result.answer, answer.answer);
    });
  }
  it('registra query corrigida e reinicia a contagem de correções por etapa', async () => {
    const fixed = 'MATCH (c:Course) RETURN count(c)';
    const { llm } = fakeLLM([multiPlan, generated(), { correctedQuery: fixed, explanation: 'Corrigida' }, generated(), { correctedQuery: fixed, explanation: 'Corrigida' }, answer]);
    const db = database([new Error('Sintaxe'), [{ value: 1 }], new Error('Sintaxe'), []]);
    const result = await invoke(buildSalesGraph(llm, db.service));
    assert.deepEqual(result.subQueries, [fixed, fixed]);
    assert.deepEqual(result.subResults, [[{ value: 1 }], []]);
    assert.equal(db.queries.length, 4);
    assert.equal(result.error, undefined);
  });
  it('interrompe após uma correção malsucedida sem avançar para a próxima etapa', async () => {
    const { llm, prompts } = fakeLLM([multiPlan, generated(), { correctedQuery: 'RETURN 1 AS value', explanation: 'Teste' }]);
    const db = database([new Error('Erro secreto interno'), new Error('Erro secreto interno')]);
    const result = await invoke(buildSalesGraph(llm, db.service));
    assert.ok(result.error);
    assert.equal(result.currentStep, 0);
    assert.equal(prompts.length, 3);
    assert.equal(db.queries.length, 2);
    assert.ok(!result.answer?.includes('secreto'));
  });
  for (const responses of [
    [{ error: 'Falha do planner' }],
    [simplePlan, { error: 'Falha na geração' }],
    [simplePlan, generated(), { error: 'Falha na correção' }],
  ]) {
    it(`encerra erro sem chamadas extras: ${JSON.stringify(responses.at(-1))}`, async () => {
      const { llm, prompts } = fakeLLM(responses);
      const db = database([new Error('Erro interno')]);
      const result = await invoke(buildSalesGraph(llm, db.service));
      assert.ok(result.error);
      assert.equal(prompts.length, responses.length);
      assert.ok(db.queries.length <= 1);
    });
  }
  it('trata ausência de resultados simples e falha na síntese', async () => {
    const { llm, prompts } = fakeLLM([simplePlan, generated(), answer]);
    const result = await invoke(buildSalesGraph(llm, database([[]]).service));
    assert.equal(result.answer, answer.answer);
    assert.ok(JSON.parse(prompts.at(-1).system).role);
    const failed = fakeLLM([simplePlan, generated(), { error: 'Falha do provedor' }]);
    assert.ok((await invoke(buildSalesGraph(failed.llm, database([[{ value: 1 }]]).service))).error);
  });
  it('rejeita plano com mais de três etapas antes de consultar', async () => {
    const { llm } = fakeLLM([{ ...multiPlan, subQuestions: ['Etapa 1', 'Etapa 2', 'Etapa 3', 'Etapa 4'] }]);
    const db = database([]);
    assert.ok((await invoke(buildSalesGraph(llm, db.service))).error);
    assert.equal(db.queries.length, 0);
  });
});

describe('Barreira Cypher determinística', () => {
  for (const query of [
    'MATCH (n) DETACH DELETE n RETURN n', 'CREATE (n) RETURN n',
    'MATCH (n) SET n.name = "x" RETURN n', 'MATCH (n) REMOVE n.name RETURN n',
    'MATCH (n) MERGE (m) RETURN n', 'MATCH (n) INSERT (m) RETURN n',
    'CALL db.labels()', 'MATCH (n) CALL apoc.load.json("https://example.com") YIELD value RETURN value',
    'LOAD CSV FROM "file:///etc/passwd" AS row RETURN row',
    'MATCH (n) RETURN n; CREATE (x)', 'MATCH (n) RETURN n // bypass',
    'MATCH (n) /* bypass */ RETURN n', 'MATCH (n) RETURN n UNION MATCH (m) RETURN m',
    'MATCH (n) RETURN apoc.version()', 'MATCH (n) RETURN n AS `x`',
    'MATCH (n) RETURN "unterminated', 'MATCH (n) RETURN "\\u0043REATE"',
    'MATCH (n) RETURN n ＣＲＥＡＴＥ (x)', 'MATCH (n) RETURN n\u0000CREATE (x)',
    'MATCH (n) RETURN n CALL { CREATE (m) } IN TRANSACTIONS',
    'MATCH p=(n)-[*]->(m) RETURN p', 'MATCH (n) RETURN collect(n)',
    'MATCH (n) RETURN {item: n}', 'CYPHER 25 MATCH (n) RETURN n',
    'MATCH (n) RETURN n FOREACH (x IN [1] | DELETE n)',
    'MATCH (n) RETURN n LIMIT 1 /* */ CREATE (x)',
  ]) {
    it(`rejeita ${JSON.stringify(query)}`, () => assert.throws(() => assertReadOnlyCypher(query)));
  }
  for (const query of ['MATCH (c:Course) RETURN c.name', 'MATCH (n) RETURN count(n) AS total',
    'OPTIONAL MATCH (s:Student)-[p:PURCHASED]->(c:Course) WHERE p.status = "paid" RETURN c.name, sum(p.amount) ORDER BY sum(p.amount) DESC LIMIT 10',
    'RETURN "CREATE is a literal" AS value', 'MATCH (c:Course) WHERE c.name = "Formação JavaScript Expert" RETURN c.name']) {
    it(`aceita ${query}`, () => assert.equal(assertReadOnlyCypher(query), query));
  }
  it('rejeita consulta longa', () => assert.throws(() => assertReadOnlyCypher('RETURN 1' + ' '.repeat(8_000))));
});

describe('Driver de leitura e limites', () => {
  function mockDriver(rows: any[] = []) {
    const calls: any = { closed: 0, sessionClosed: 0, queries: [], fail: false };
    const driver = {
      session(options: any) {
        calls.session = options;
        return {
          executeRead: async (callback: any, options: any) => {
            calls.transaction = options;
            return callback({ run: async (query: string, params: any) => {
              calls.queries.push({ query, params });
              if (calls.fail) throw new Error('Timeout simulado');
              return { records: rows.map(row => ({ toObject: () => row })) };
            } });
          },
          close: async () => { calls.sessionClosed++; },
        };
      },
      close: async () => { calls.closed++; },
    } as unknown as Driver;
    return { service: new Neo4jService(driver), calls };
  }
  it('limita no Cypher enviado, define timeout e fecha sessão', async () => {
    const { service, calls } = mockDriver([{ total: 3 }]);
    assert.deepEqual(await service.query('MATCH (n) RETURN count(n) AS total LIMIT 999999'), [{ total: 3 }]);
    assert.equal(calls.queries[0].query, 'CALL { MATCH (n) RETURN count(n) AS total LIMIT 999999 } RETURN * LIMIT $resultLimit');
    assert.equal(calls.queries[0].params.resultLimit.toNumber(), 100);
    assert.equal(calls.transaction.timeout, 5_000);
    assert.equal(calls.session.defaultAccessMode, 'READ');
    assert.equal(calls.session.database, config.neo4j.database);
    assert.equal(calls.sessionClosed, 1);
    await service.close();
    assert.equal(calls.closed, 1);
  });
  it('bloqueia mutação antes de abrir sessão', async () => {
    const { service, calls } = mockDriver();
    await assert.rejects(service.query('CREATE (n) RETURN n'));
    assert.equal(calls.session, undefined);
  });
  it('propaga erro do driver e fecha sessão', async () => {
    const { service, calls } = mockDriver();
    calls.fail = true;
    await assert.rejects(service.query('RETURN 1 AS value'), /Timeout simulado/);
    assert.equal(calls.sessionClosed, 1);
  });
  it('recusa payload excessivo e fecha sessão também no erro', async () => {
    const { service, calls } = mockDriver([{ text: 'a'.repeat(65_536) }]);
    await assert.rejects(service.query('RETURN 1 AS value'), /bytes/);
    assert.equal(calls.sessionClosed, 1);
  });
});

describe('HTTP offline', () => {
  const key = 'chave-de-teste-local-com-32-caracteres';
  function appWith(invoke: (...args: any[]) => any = async () => answer) {
    return createServer({ graph: { invoke }, neo4jService: { close: async () => {} } } as any, key);
  }
  const request = (app: ReturnType<typeof createServer>, question: unknown = 'Quantos cursos existem?', supplied: unknown = key) =>
    app.inject({ method: 'POST', url: '/sales', headers: supplied ? { 'x-api-key': supplied as string } : {}, payload: { question } });
  it('exige chave forte na configuração', () => assert.throws(() => createServer(undefined, 'curta'), /32/));
  it('bloqueia ausência/chave incorreta antes do grafo e permite chave válida', async () => {
    let called = 0;
    const app = appWith(async () => { called++; return answer; });
    try {
      assert.equal((await request(app, 'Pergunta?', '')).statusCode, 401);
      assert.equal((await request(app, 'Pergunta?', 'outra-chave')).statusCode, 401);
      assert.equal((await request(app, 'Pergunta?', 'x'.repeat(key.length))).statusCode, 401);
      const valid = await request(app);
      assert.equal(valid.statusCode, 200);
      assert.deepEqual(valid.json(), answer);
      assert.equal(called, 1);
    } finally { await app.close(); }
  });
  it('valida tipo, tamanho, texto vazio e corpo antes do grafo', async () => {
    const app = appWith(() => { throw new Error('Não deve consultar'); });
    try {
      for (const question of [1, 'ab', '   ', 'a'.repeat(2_001)]) assert.equal((await request(app, question)).statusCode, 400);
      assert.equal((await request(app, 'a'.repeat(9_000))).statusCode, 413);
      assert.equal((await app.inject({ method: 'POST', url: '/sales', headers: { 'x-api-key': key }, payload: { question: 'Pergunta?', extra: true } })).statusCode, 400);
    } finally { await app.close(); }
  });
  it('retorna erro genérico sem dados internos', async () => {
    for (const invoke of [async () => { throw new Error('segredo interno'); }, async () => ({ error: 'segredo interno' })]) {
      const app = appWith(invoke);
      try { const response = await request(app); assert.equal(response.statusCode, 502); assert.ok(!response.body.includes('segredo')); }
      finally { await app.close(); }
    }
  });
  it('limita dez requisições por minuto', async () => {
    const app = appWith();
    try {
      for (let i = 0; i < 10; i++) assert.equal((await request(app)).statusCode, 200);
      assert.equal((await request(app)).statusCode, 429);
    } finally { await app.close(); }
  });
  it('limita uma análise concorrente', async () => {
    let resolve!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>(done => { started = done; });
    const app = appWith(() => { started(); return new Promise(done => { resolve = done; }); });
    try {
      const first = request(app).then(response => response);
      await entered;
      assert.equal((await request(app)).statusCode, 429);
      resolve(answer);
      assert.equal((await first).statusCode, 200);
    } finally { await app.close(); }
  });
});

it('seed exige confirmação antes de qualquer conexão', async () => {
  await assert.rejects(seedDatabase(false), /Confirmação/);
});
