import { timingSafeEqual } from 'node:crypto';
import { buildSalesQAGraph } from './graph/factory.ts';
import Fastify from 'fastify';
import { HumanMessage } from '@langchain/core/messages';

type Dependencies = ReturnType<typeof buildSalesQAGraph>;

export const createServer = (dependencies?: Dependencies, apiKey = process.env.SALES_API_KEY ?? '') => {
  if (apiKey.length < 32) throw new Error('SALES_API_KEY deve conter pelo menos 32 caracteres.');
  const { graph, neo4jService } = dependencies ?? buildSalesQAGraph();
  const app = Fastify({ logger: false, bodyLimit: 8_192, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  let busy = false;
  let requests: number[] = [];
  app.addHook('onClose', async () => neo4jService.close());
  app.post('/sales', {
    onRequest: async (request, reply) => {
      const supplied = request.headers['x-api-key'];
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(apiKey) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(apiKey))) {
        return reply.code(401).send({ error: 'Não autorizado.' });
      }
    },
    schema: {
      body: {
        type: 'object', required: ['question'], additionalProperties: false,
        properties: { question: { type: 'string', minLength: 3, maxLength: 2_000, pattern: /\S/.source } },
      },
    },
  }, async (request, reply) => {
    requests = requests.filter(time => time > Date.now() - 60_000);
    if (busy || requests.length >= 10) {
      return reply.code(429).send({ error: 'Limite de requisições atingido. Tente novamente depois.' });
    }
    busy = true;
    requests.push(Date.now());
    try {
      const { question } = request.body as { question: string };
      const response = await graph.invoke({ messages: [new HumanMessage(question)] }, { recursionLimit: 24 });
      if (response.error) return reply.code(502).send({ error: 'Não foi possível concluir a análise.' });
      return { answer: response.answer, followUpQuestions: response.followUpQuestions ?? [] };
    } catch {
      return reply.code(502).send({ error: 'Não foi possível concluir a análise.' });
    } finally {
      busy = false;
    }
  });
  return app;
};
