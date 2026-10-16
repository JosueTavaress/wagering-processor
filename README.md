# Distributed Wagering Processor

Processador financeiro de apostas com Bun, NestJS, PostgreSQL, MikroORM e SQS/LocalStack. Código organizado em `domain`, `application` e `infra`, com Input/Output separados por caso de uso.

**Verificação:** typecheck e 227 testes aprovados em containers no Ubuntu/WSL em 16/10/2026: 179 de unidade, 24 de integração e 24 de concorrência, sem falhas. A formatação foi aprovada separadamente em execução local. Consulte [VERIFICATION.md](VERIFICATION.md) para os resultados e [docs/TESTING.md](docs/TESTING.md) para a cobertura.

## Modelagem e arquitetura

Usei padrões táticos de DDD para modelar as regras financeiras: `Money` como objeto de valor imutável, `Wallet` como raiz de agregado, `WagerTransaction` com transições explícitas e `WagerPolicy` para regras que envolvem essas entidades. Repositories abstraem a persistência, e eventos de integração registram os resultados para publicação pela outbox.

A organização segue princípios de Clean Architecture: `domain` concentra as regras sem depender de frameworks; `application` coordena os casos de uso e define portas; `infra` implementa HTTP, banco e mensageria. Mantive um único serviço, com API e workers em processos separados. As decisões e os limites estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Iniciar usando apenas Docker

Pré-requisitos: Docker Engine/Desktop com Compose v2; portas 3000–3002, 5432 e 4566 livres; imagens/dependências. No Windows, use Docker Desktop com containers Linux/WSL2.

Na pasta descompactada:

```bash
docker compose up -d --build
```

A inicialização cria o schema e as filas automaticamente. Três APIs ficam disponíveis em `http://localhost:3000`, `:3001` e `:3002`; três consumidores, dois publishers e um worker de referências executam separadamente. PostgreSQL possui volume persistente. O LocalStack demonstrativo não possui persistência configurada: reiniciar o container pode apagar filas/mensagens; rode novamente o serviço `queues` se necessário. Não use isso como configuração de produção.

```bash
curl http://localhost:3000/health/ready
docker compose exec api bun run demo
```

O demo envia duas apostas concorrentes de 80.00 contra 100.00 e mostra reconciliação final. Resultado esperado: um processamento, uma rejeição e saldo 20.00.

## Testar

Somente Docker:

```bash
docker compose --profile test run --build --rm tests
```

Para rodar apenas concorrência:

```bash
docker compose --profile test run --build --rm tests bun run test:concurrency
```

A suíte cobre três APIs independentes, disputas por saldo e idempotência, créditos/débitos simultâneos, oito wallets, HTTP concorrendo com SQS, referências fora de ordem e recuperação de workers. Cada cenário novo verifica saldo, versão, continuidade e unicidade do ledger. O inventário e os limites estão em [docs/TESTING.md](docs/TESTING.md).

Os testes criam bancos e filas com nomes aleatórios e removem seus recursos ao concluir. O usuário de banco dos testes precisa de `CREATEDB`. O usuário inicial do Compose já possui essa capacidade. Os testes não usam o saldo das APIs do demo.

Com Bun 1.2.23 instalado localmente:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
docker compose up -d postgres localstack
bun run test:integration
bun run test:concurrency
```

Não precisa configurar `.env` para os padrões locais. Para alterar conexões, copie `.env.example` para `.env`. O Bun carrega esse arquivo automaticamente. As credenciais locais são demonstrativas e não são segredos de produção.

`test:integration` e `test:concurrency` recusam iniciar se PostgreSQL ou LocalStack não estiverem alcançáveis. Não substituem esses serviços por mocks. A suíte de unidade usa doubles apenas para testar orquestração, sem alegar garantias de persistência/concorrência.

## Desenvolvimento local

```bash
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run migrate
bun run queues
bun run start
```

Em outro terminal: `bun run worker`. Este comando inicia os três tipos de worker no mesmo processo para desenvolvimento; o Compose separa os papéis. `WORKER_ROLE` aceita `consumer`, `publisher`, `reference` ou `all`.

## Endpoints

| Método | Endpoint                                                              | Finalidade                                            |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------- |
| POST   | `/wallets`                                                            | Abrir wallet; saldo positivo gera OPENING e ledger    |
| GET    | `/wallets/:walletId`                                                  | Saldo e versão atuais                                 |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | Ledger com cursor opaco                               |
| POST   | `/wagering/transactions`                                              | Processar comando; header Idempotency-Key obrigatório |
| GET    | `/wagering/transactions/:transactionId`                               | Resultado persistido                                  |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade externa                      |
| POST   | `/wallets/:walletId/reconciliation`                                   | Comparar saldo e soma do ledger                       |
| GET    | `/health/live`                                                        | Processo vivo                                         |
| GET    | `/health/ready`                                                       | PostgreSQL e SQS disponíveis                          |
| GET    | `/metrics`                                                            | Métricas Prometheus                                   |

Exemplos HTTP completos estão em `docs/requests.http`. Dinheiro sempre entra e sai como `{ "amount": "25.00", "currency": "BRL" }`. Rejeições financeiras são persistidas e retornam HTTP 422; reenvio da mesma chave não reavalia uma rejeição terminal.

## Enviar via SQS

Use `scripts/send.ts caminho/command.json`. O arquivo contém o comando, incluindo `idempotencyKey`, no formato de `docs/command.example.json`. Preencha wallet/player existentes.

```bash
bun scripts/send.ts docs/command.example.json
```

A mensagem recebe envelope `WagerTransactionRequested`. O script gera identificador e deduplication ID de transporte; para simular redelivery, reenvie o mesmo `messageId` usando a variável `MESSAGE_ID`. O banco continua sendo a garantia de idempotência, independentemente do dedup do SQS.

Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. Esta última recebe eventos, não comandos. `QUEUE_PREFIX` é reservado para isolamento dos testes.

## Operação e diagnóstico

```bash
docker compose logs -f api consumer publisher reference
curl http://localhost:3000/metrics
docker compose exec consumer bun -e "console.log(await (await fetch('http://localhost:9090/metrics')).text())"
```

Métricas são por processo. A API não agrega métricas dos workers; colete cada instância em produção. Com réplicas, use `docker compose exec --index 2 consumer ...` para inspecionar outra instância.

- `500`: erro interno; investigar antes de decidir por novo envio.
- `503`: dependência indisponível; retry com a mesma chave, nunca uma nova chave para a mesma operação.
- `409`: conflito de identidade/payload; revise a solicitação.
- `202`: referência pendente; consulte o resultado posteriormente.
- `422`: rejeição de negócio terminal, com `failureCode`.
- Outbox lag crescente: confira conectividade SQS e logs do publisher.
- DLQ crescente: confira `failed_messages`, logs e envelope. Não reenvie cegamente conflitos de payload.

Reiniciar os processos da aplicação preserva saldos e outbox no PostgreSQL. Para parar sem apagar dados: `docker compose down`. **`docker compose down -v` apaga o banco do demo.**

## Migrations

`bun run migrate` aplica migrations pendentes sob advisory lock exclusivo de migração. Esse lock só existe no bootstrap, não no processamento de wallets. `bun run migrate down` reverte a última migration aplicada. Reverter a 001 remove tabelas e dados: faça isso apenas em banco descartável. Nunca existe `synchronize` automático.

## Leitura sugerida

1. `ARCHITECTURE.md`: decisões e limites das garantias.
2. `VERIFICATION.md`: evidência real de verificação.
3. `CHALLENGE.md`: enunciado original.

Sem frontend, autenticação completa, tracing, dashboard, teste de carga ou partidas dobradas: são opcionais, fora do foco desta entrega.

Para acompanhar uma operação do recebimento à recuperação após falhas, siga o [passo a passo do processamento](docs/FLUXO.md).
