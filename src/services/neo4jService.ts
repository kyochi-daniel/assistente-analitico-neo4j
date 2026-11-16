import neo4j, { type Driver } from 'neo4j-driver';
import { config, validateDatabaseConfig } from '../config.ts';
import { assertReadOnlyCypher } from './cypherSafety.ts';

export class Neo4jService {
  private driver: Driver;

  constructor(driver?: Driver) {
    if (driver) {
      this.driver = driver;
    } else {
      validateDatabaseConfig();
      this.driver = neo4j.driver(config.neo4j.uri,
        neo4j.auth.basic(config.neo4j.username, config.neo4j.password), {
          maxTransactionRetryTime: 0,
          connectionAcquisitionTimeout: 5_000,
          connectionTimeout: 5_000,
          disableLosslessIntegers: true,
        });
    }
  }

  async getSchema(): Promise<string> {
    return `Student {id, name, email, phone}; Course {name, url};
    (Student)-[:PURCHASED {status, paymentMethod, paymentDate, amount}]->(Course);
    (Student)-[:PROGRESS {progress}]->(Course)`;
  }

  async query(query: string): Promise<Record<string, unknown>[]> {
    const safeQuery = assertReadOnlyCypher(query);
    const session = this.driver.session({
      database: config.neo4j.database,
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      // O limite externo também restringe queries sem LIMIT ou com LIMIT gerado excessivo.
      return await session.executeRead(async transaction => {
        const result = await transaction.run(
          `CALL { ${safeQuery} } RETURN * LIMIT $resultLimit`,
          { resultLimit: neo4j.int(config.maxRows) },
        );
        const rows = result.records.map(record => record.toObject());
        if (Buffer.byteLength(JSON.stringify(rows)) > config.maxResultBytes) {
          throw new Error('Resultado excedeu o limite de bytes.');
        }
        return rows;
      }, { timeout: config.queryTimeoutMs });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
