# Assistente analítico com Neo4j

Estudo acadêmico de perguntas em linguagem natural sobre cursos, compras e progresso de alunos. Um grafo LangGraph planeja a pergunta, gera Cypher, consulta um banco Neo4j dedicado e produz uma resposta com sugestões de continuidade.

Este trabalho adapta o **exemplo 06 do módulo 2**, apresentado por **Erick Wendel / Unipds**, no curso Engenharia de Software com IA Aplicada. A base didática e sua autoria foram preservadas. As correções locais estão descritas abaixo; este repositório não representa um produto oficial dos autores.

- Material original: [Engenharia de Software com IA Aplicada](https://github.com/unipds-engenharia-de-ia-aplicada/engenharia-de-software-com-ia-aplicada).
- Termos originais: [LICENSE.md](LICENSE.md), CC BY-NC-ND 4.0, mantidos integralmente. A autorização informada para esta publicação acadêmica não altera os termos para terceiros.

## O que o exercício demonstra

A API recebe `POST /sales` com uma pergunta. O planejador escolhe uma consulta simples ou até três subperguntas independentes. Cada etapa gera uma consulta usando o esquema fixo do exercício. Antes de qualquer acesso ao banco, uma barreira determinística rejeita construções fora do subconjunto de leitura aceito.

A execução usa uma transação de leitura, timeout e limite externo de linhas. Uma falha permite uma tentativa de correção por etapa; uma segunda falha encerra a análise. Perguntas, consultas executadas e resultados de cada etapa permanecem alinhados, inclusive resultados vazios. A síntese recebe todas as etapas juntas. Os resultados limitados são identificados como tal no prompt.

A separação de responsabilidades existente foi mantida:

```text
src/server.ts                  API e autenticação
src/graph/                     estado, fluxo e nós LangGraph
src/services/                  OpenRouter, driver Neo4j e barreira Cypher
src/prompts/v1/                prompts e schemas de saída
src/config.ts                  ambiente e limites
 data/                         cursos e gerador de dados fictícios
 tests/sales.test.ts            verificações determinísticas offline
```

## Requisitos

- Node.js **24.10 ou superior**, com execução nativa dos arquivos TypeScript.
- npm e acesso à internet para instalar dependências.
- Docker com Compose, caso use a infraestrutura local fornecida.
- Conta/chave OpenRouter para executar análises reais e um modelo compatível com saída estruturada. Disponibilidade, limites e cobrança dependem do provedor. Os testes não usam essa conta.

## Preparação local

```sh
npm ci
cp .env.example .env
```

Preencha `.env` localmente. Gere `SALES_API_KEY` aleatória com pelo menos 32 caracteres. Por exemplo, `openssl rand -hex 32` gera um valor para copiar ao arquivo. Preencha `OPENROUTER_API_KEY`; `OPENROUTER_MODEL` é opcional e substitui o modelo definido em `src/config.ts`.

Para o Compose, defina `NEO4J_ADMIN_PASSWORD` com uma senha própria. O serviço cria uma instância descartável com banco inicial **sales-demo**, volume próprio e portas **17474/17687**, publicadas somente em `127.0.0.1`. Não usa a instalação Neo4j do computador.

```sh
npm run docker:infra:up
```

Aguarde a inicialização no log (`npm run docker:infra:logs`) ou no Browser em `http://127.0.0.1:17474`. Configure:

- `NEO4J_URI=bolt://127.0.0.1:17687` e `NEO4J_DATABASE=sales-demo`.
- `NEO4J_USERNAME` e `NEO4J_PASSWORD` para consultas.
- `NEO4J_SEED_USERNAME` e `NEO4J_SEED_PASSWORD` para a carga explícita.

A edição Community fornecida não oferece o isolamento por permissões de uma implantação Enterprise. **Somente nesta instância local, descartável e com dados fictícios**, as variáveis de consulta e seed podem apontar para o usuário `neo4j` e a senha de administração definida localmente. Não há credenciais padrão no código.

Para dados reais, use uma instância dedicada com controle de acesso no servidor: conta da aplicação com acesso e leitura apenas em `sales-demo`, sem escrita, administração ou execução de procedures; conta de seed separada com escrita. O modo `executeRead` controla roteamento e não substitui autorização do banco. Esta demonstração rejeita outro nome de banco; apontar a URI para uma instalação compartilhada continua sendo uma configuração indevida.

### Carga inicial explícita

**O comando abaixo apaga todos os nós de `sales-demo` antes de inserir os dados fictícios.** Confira a URI e use somente a instância descartável criada para este estudo.

```sh
npm run seed -- --reset --confirm-dedicated-db
```

Sem as duas flags, o comando encerra sem conectar. O helper exige confirmação explícita e credenciais próprias de seed. Não há seed na inicialização da API nem nos testes. A carga usa Faker e não é um conjunto contábil real; compras repetidas do mesmo curso/aluno são consolidadas pela relação do grafo.

### API

```sh
npm start
```

A API escuta somente `http://127.0.0.1:4000`. Exemplo em um terminal onde `SALES_API_KEY` já esteja exportada:

```sh
curl http://127.0.0.1:4000/sales \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $SALES_API_KEY" \
  --data '{"question":"Quais cursos têm maior receita?"}'
```

Resposta de sucesso: `{ "answer": "...", "followUpQuestions": [] }`. A rota responde `401` sem chave válida, `400` para entrada inválida, `413` para corpo excessivo, `429` para limite de uso e `502` quando não consegue concluir a análise. Erros públicos não incluem detalhes internos nem consultas.

```sh
npm run docker:infra:down
```

Esse comando para o serviço e preserva o volume. A API não inicia nem apaga o banco automaticamente.

## Limites e cuidados do exercício

- Uma análise por vez e dez solicitações autenticadas por minuto, por processo. Não há controle distribuído, usuários individuais ou exposição pública preparada.
- Pergunta com 3 a 2.000 caracteres e algum texto não vazio; corpo HTTP de até 8 KiB; campos extras são rejeitados.
- Até três etapas, uma correção por etapa, consulta com até 8.000 caracteres, até **100 linhas por etapa**, timeout transacional de **5 segundos** e até **64 KiB de resultado serializado por etapa**.
- O limite externo de linhas é aplicado pelo banco mesmo sem `LIMIT` gerado. O teto de bytes é verificado após receber e serializar o resultado; não é um limite de memória do servidor Neo4j. O Compose limita a memória do contêiner a 1 GiB. Consultas caras podem atingir timeout ou esse limite.
- O filtro aceita um subconjunto conservador de Cypher: proíbe mutações, procedures, comentários, múltiplas instruções, subconsultas geradas, caminhos de tamanho variável e funções fora de uma lista explícita. Aceita acentos em literais, mas exige identificadores ASCII. Consultas legítimas podem ser recusadas; o filtro não é um parser completo nem substitui permissões do banco.
- Não depende de APOC. O esquema é fixo para os dados deste exercício e deve ser atualizado caso o modelo mude.
- Chamadas ao modelo têm timeout de 30 segundos, sem retry de transporte, saída de até 4.096 tokens e limite de recursão do agente. Uma análise pode fazer várias chamadas; o timeout não é um prazo único para toda a requisição.
- Perguntas e resultados são enviados ao OpenRouter/modelo escolhido. Use exclusivamente dados sintéticos. Respostas podem conter erros ou cálculos incorretos; não há garantia de precisão analítica nem benchmark de qualidade.
- A síntese pode trabalhar com resultados parciais pelo limite de linhas. O prompt informa esse limite, mas a redação do modelo não é garantida. Os passos são consultas independentes, sem passagem de resultados intermediários para gerar o próximo Cypher.
- O seed realiza operações sucessivas e pode deixar uma carga parcial se houver falha. Reexecute explicitamente somente no banco descartável.

## Verificação realizada

```sh
npm test
npm run typecheck
```

Foram executados **53 testes offline**, com Node.js 24.11.1. A suíte percorre o grafo LangGraph real com respostas LLM simuladas, autenticação e validação HTTP via Fastify, agrupamento e síntese de etapas vazias, correção limitada e interrupção em erros. Também verifica bloqueios de mutação/procedures e tentativas de contornar o filtro, montagem do limite externo, configuração de timeout, teto de bytes, fechamento de sessões e confirmação do seed.

Não foi iniciado um banco nesta verificação. O driver é simulado nos testes: o timeout e o limite de linhas são conferidos nos comandos/opções enviados, sem medir sua aplicação em um Neo4j real. Não houve chamadas ao OpenRouter, avaliação semântica de respostas reais ou execução destrutiva do seed. A antiga suíte E2E que carregava/apagava dados e chamava serviços externos foi substituída por testes determinísticos.

## Alterações nesta adaptação

Correção do encadeamento de múltiplas etapas e do encerramento em erros; execução restrita com limites; autenticação da API; configuração por ambiente; separação do seed destrutivo; infraestrutura local isolada; testes offline e documentação de execução. O código e os prompts didáticos de origem continuam identificados pelos créditos acima. O campo `author` do pacote permanece `erickwendel`; a licença do pacote remete a `LICENSE.md`.
