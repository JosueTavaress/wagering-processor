# Carga e custo do histórico

O experimento compara uma wallet disputada e oito wallets independentes, pelas três APIs do Compose. Cada fase cria wallets próprias, aquece com dez apostas e envia 300 BETs distintas de 1.00 BRL, com oito clientes concorrentes. Não há meta de RPS. As wallets e seus lançamentos ficam no banco do demo; não são excluídos.

## Executar

```bash
docker compose up -d --build
mkdir -p docs/verification
set -o pipefail
docker compose exec -T \
  -e LOAD_API_URLS=http://api:3000,http://api2:3000,http://api3:3000 \
  -e LOAD_REVISION="$(git rev-parse HEAD)" \
  api bun run test:load 2>&1 | tee "docs/verification/load-$(date +%Y%m%d-%H%M%S).log"
```

Com Bun local e o Compose já iniciado, também funciona `bun run test:load`. O script precisa acessar as APIs, PostgreSQL e publishers ativos. Se o drain da outbox não concluir no prazo, a execução termina com erro e mantém a contagem de eventos pendentes no relatório.

Parâmetros opcionais: `LOAD_REQUESTS` (300 por fase), `LOAD_CONCURRENCY` (8), `LOAD_WALLETS` (8 na segunda fase), `LOAD_DRAIN_TIMEOUT_MS` (30000), `LOAD_API_URLS` e `LOAD_ENVIRONMENT` (descrição do ambiente). Os quatro parâmetros numéricos exigem inteiros positivos com limites explícitos no script. Registre também os limites de CPU/memória do Docker e qualquer tráfego concorrente.

## Interpretar

O relatório JSON registra Bun, PostgreSQL, sistema, CPU/memória visíveis, APIs e revisão quando informada/disponível. A imagem não contém `.git`: nesse caso, o estado da árvore aparece como desconhecido. Se houver alterações não commitadas, o hash identifica apenas o commit de base; registre `git status --short` junto ao resultado.

Por fase, o relatório inclui:

- Throughput e duração somente da carga medida, excluindo aquecimento e drain.
- p50/p95/p99 de todas as tentativas, incluindo erros e tempo de leitura da resposta; taxa de erro e status HTTP.
- Latências do primeiro e último terços por ordem de envio.
- Diferença dos contadores de conflito de lock nas APIs durante a fase. O contador mede deadlocks/timeouts, não toda espera por lock; tráfego externo ou reinício de API prejudicam essa medida.
- Maior outbox lag observado por amostragem de um segundo, além do backlog final e tempo de drain. Não é uma medição contínua do pico.
- Saldo reconstruído, quantidade de lançamentos e apostas efetivamente processadas de cada wallet.
- Duas amostras de `EXPLAIN ANALYZE` da soma do ledger da primeira wallet: após aquecimento e após carga, com os tamanhos do histórico.

O tempo do `EXPLAIN ANALYZE` é uma amostra da consulta de soma, não o custo completo das constraints diferidas ou do commit. Diferenças entre os terços também incluem fila, cache e disputa. Repita em ambiente controlado antes de atribuir uma regressão ao histórico ou substituir a proteção atual por validação incremental.

## Evidência disponível

A tentativa local de `bun run test:load` foi interrompida antes da carga por `ECONNREFUSED 127.0.0.1:5432`; Docker também está inacessível neste ambiente. O experimento ainda não foi executado com os serviços reais nesta revisão. Não há números de throughput ou latência aprovados. Depois da execução, mantenha o log completo e registre ambiente, parâmetros e interpretação, incluindo erros e limitações; um relatório produzido pelo script não é uma meta de desempenho cumprida.
