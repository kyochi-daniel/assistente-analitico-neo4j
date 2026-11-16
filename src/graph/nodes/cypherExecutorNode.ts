import config from '../../config.ts';
import { Neo4jService } from '../../services/neo4jService.ts';
import type { GraphState } from '../graph.ts';

export function createCypherExecutorNode(neo4jService: Neo4jService) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    try {
      const results = await neo4jService.query(state.query!);
      return {
        dbResults: results,
        ...(state.isMultiStep ? {
          subResults: [...(state.subResults ?? []), results],
          currentStep: (state.currentStep ?? 0) + 1,
        } : {}),
        correctionAttempts: 0,
        needsCorrection: false,
        validationError: undefined,
        originalQuery: undefined,
      };
    } catch {
      if ((state.correctionAttempts ?? 0) < config.maxCorrectionAttempts) {
        return {
          validationError: 'Consulta rejeitada ou falha na execução. Use apenas o subconjunto de leitura permitido.',
          originalQuery: state.originalQuery ?? state.query,
          needsCorrection: true,
        };
      }
      return { error: 'Falha na consulta após a tentativa de correção.', needsCorrection: false };
    }
  };
}
