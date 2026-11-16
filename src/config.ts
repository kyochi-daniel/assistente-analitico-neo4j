export const config = {
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  httpReferer: '',
  xTitle: 'Assistente Analítico Neo4j - estudo acadêmico',
  models: [process.env.OPENROUTER_MODEL || 'arcee-ai/trinity-large-preview:free'],
  temperature: 0,
  neo4j: {
    uri: process.env.NEO4J_URI ?? '',
    username: process.env.NEO4J_USERNAME ?? '',
    password: process.env.NEO4J_PASSWORD ?? '',
    database: process.env.NEO4J_DATABASE ?? '',
  },
  maxCorrectionAttempts: 1,
  maxSubQuestions: 3,
  maxRows: 100,
  maxResultBytes: 65_536,
  queryTimeoutMs: 5_000,
};

export function validateDatabaseConfig() {
  if (Object.values(config.neo4j).some(value => !value)) {
    throw new Error('Configure NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD e NEO4J_DATABASE.');
  }
  if (config.neo4j.database !== 'sales-demo') {
    throw new Error('Esta demonstração exige o banco dedicado sales-demo.');
  }
}

export default config;
