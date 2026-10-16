# Estratégia de testes

O objetivo é demonstrar que cada operação financeira tem um único efeito, mesmo quando requisições competem entre processos ou transportes. As suítes de integração e concorrência usam PostgreSQL e LocalStack reais; recusam iniciar se esses serviços não estiverem disponíveis.

## Executar

Todos os checks, com Bun incluído na imagem:

```bash
docker compose --profile test run --build --rm tests
```

Somente concorrência:

```bash
docker compose --profile test run --build --rm tests bun run test:concurrency
```

Com Bun 1.2.23 e os serviços locais disponíveis:

```bash
bun run typecheck
bun run test
bun run test:integration
bun run test:concurrency
```

Cada suíte de containers cria um banco e um prefixo de filas exclusivos. O usuário de banco precisa de CREATEDB. Os testes usam portas internas fixas 43100–43102 (integração), 43200–43202 (concorrência) e 43390 (health do worker no teste de shutdown); evite executar duas cópias da mesma suíte no mesmo namespace de rede. Os recursos são removidos no encerramento normal. Uma interrupção abrupta pode deixar recursos de teste para limpeza posterior.

## Concorrência: 24 cenários

Arquivo: `test/concurrency/processes.test.ts`. As requisições HTTP são distribuídas entre três processos independentes. `Promise.all` dispara requisições concorrentes reais; a ordem em que o PostgreSQL concede o lock não é presumida.

| Cenário                                               | O que deve acontecer                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Mesma BET enviada 50 vezes                            | Um débito, uma identidade financeira e 49 replays                                |
| Duas BETs de 80 contra saldo 100                      | Uma processada, outra sem saldo, saldo final 20                                  |
| Wallet bloqueada enquanto outra recebe uma BET        | A outra wallet progride antes da liberação do lock                               |
| Três REFUNDs diferentes da mesma referência           | Um crédito; duas rejeições ALREADY_REVERSED                                      |
| Consumer morto depois do commit, antes do ack         | Redelivery, inbox única, um débito e replay após reiniciar a API                 |
| Três consumers para 15 apostas na mesma wallet        | Dez processadas; as demais não produzem saldo negativo                           |
| Publisher morto após enviar, antes de confirmar       | Dois publishers recuperam a outbox; todos os eventIds e envelopes chegam à fila  |
| Mesma WIN enviada 50 vezes                            | Um crédito e uma alteração de versão                                             |
| Mesma LOSS enviada 50 vezes                           | Uma identidade financeira, nenhum ledger ou alteração de versão                  |
| Mesmo REFUND enviado 50 vezes                         | Um crédito de devolução                                                          |
| Mesmo ROLLBACK de WIN enviado 50 vezes                | Um débito de reversão                                                            |
| 30 BETs diferentes disputando saldo 100               | Dez processadas e vinte rejeitadas; replays preservam cada resultado             |
| 15 WINs e 15 BETs concorrentes                        | Nenhum update perdido; saldo e versão refletem os 30 efeitos                     |
| Uma chave com dois valores diferentes                 | Um payload vencedor; o outro retorna conflito                                    |
| Mesma identidade externa com 18 chaves distintas      | Uma operação financeira e 17 conflitos                                           |
| Três provedores usando o mesmo id externo             | Três operações independentes                                                     |
| Oito wallets recebendo 48 apostas                     | Saldo e versão corretos em cada wallet                                           |
| Replays concorrentes de rejeição após novo crédito    | Rejeição e saldo originalmente observado permanecem iguais                       |
| HTTP e três consumers disputando a mesma operação     | Um débito, com 15 registros de inbox para envelopes distintos                    |
| Dois workers para seis reversões antes da BET         | Uma reversão por tipo; concorrentes rejeitadas; sem efeito duplicado             |
| BET disputando saldo com ROLLBACK de WIN              | Só uma consegue debitar; a outra usa o código de insuficiência adequado          |
| Doze aberturas da mesma wallet                        | Uma wallet e um crédito OPENING                                                  |
| Chave global disputada por duas wallets               | Uma wallet debitada; a outra permanece intacta                                   |
| SIGTERM durante transação bloqueada por outra conexão | Worker fica not-ready, conclui o débito/ack após liberação e encerra normalmente |

O cenário de REFUND e ROLLBACK sobre a mesma BET segue a interpretação documentada em ARCHITECTURE.md: é permitida uma reversão de cada tipo. Não é um cenário de exclusão mútua entre os dois tipos.

## Assertions financeiras

Todos os cenários novos conferem:

- Saldo final e versão da wallet.
- Reconciliação sem diferença.
- Continuidade entre balance_after de um lançamento e balance_before do seguinte.
- Aritmética exata de cada lançamento, usando Money.
- Ausência de saldos intermediários negativos no ledger.
- Ausência de lançamentos duplicados para uma transação.
- Um evento Processed/Rejected por resultado terminal correspondente e um BalanceChanged por lançamento, sem novos eventos em replay.
- Exatamente um lançamento para cada transação PROCESSED com efeito financeiro; nenhum para LOSS ou transações não processadas.

As expectativas não dependem de qual requisição vence a disputa. Quando há mais de um resultado serial válido, o teste aceita ambos e verifica suas consequências. Exemplos: disputa entre BET e ROLLBACK e escolha do payload vencedor em conflito de idempotência.

Workers iniciados pelos novos testes são encerrados em finally. Os testes de crash usam a promise exited e exigem SIGKILL, sem depender de exitCode ser preenchido em término por sinal.

## Integração e unidade

`test/integration/system.test.ts` cobre migrations reversíveis, constraints, abertura, replay, regras de reversão, moeda, atomicidade com falha na outbox, referências fora de ordem, expiração, inbox/redelivery, retry/DLQ, publishers, HTTP, paginação e métricas. Inclui regressões de direção/continuidade do ledger e cursor fora do intervalo bigint.

`test/unit` cobre Money, Wallet, transições terminais, regras, hash canônico, orquestração e espera de processos encerrados por sinal. Doubles nessa camada servem para testar decisões locais, não para demonstrar locking ou consistência distribuída.

## Limites da evidência

- A suíte completa passou no Ubuntu/WSL em 16/10/2026: typecheck e 216 testes (170 de unidade, 22 de integração e 24 de concorrência), incluindo configuração, classificação de falhas, heartbeat, strings compartilhadas e inicialização HTTP. A evidência está em VERIFICATION.md.
- São testes de correção, não um benchmark. Não há alegação de throughput ou percentis de latência.
- O teste downstream usa uma fila real com três transport ids diferentes para o mesmo eventId e uma inbox SQL persistente. Ele demonstra um consumidor de referência de teste; não acrescenta um serviço downstream de produção.
- Há teste de SIGTERM com uma transação bloqueada, identificada por pg_blocking_pids. Não há simulação de partição prolongada de rede.
- A falha transitória de banco é induzida por um trigger de teste que lança SQLSTATE 08006 no PostgreSQL. Após removê-lo, a mensagem é reentregue e processada pelo caso de uso real. Isso não representa uma interrupção física da conexão.
- HTTP concorrente demonstra que a correção financeira não depende da ordenação do FIFO. O teste com três consumers na mesma wallet, isoladamente, não elimina a serialização do MessageGroupId.

## Contratos e tratamento de erros

Os testes de unidade distinguem HTTP 400/404/409/422/500/503, cobrem campos obrigatórios de eventos em tempo de compilação e verificam que erros de programação não são persistidos como rejeições de negócio. Também verificam cópias defensivas de datas. A integração inclui uma publicação que falha, persiste o backoff da entidade e depois publica com o broker real. Essa falha é injetada no transporte; a persistência continua sendo PostgreSQL real.

Esses testes passaram na execução em containers de 16/10/2026, incluindo os 24 cenários de concorrência, conforme VERIFICATION.md.

## Regressões da revisão crítica

A integração agora contém 22 cenários. Os casos adicionais verificam:

- TTL e limite de tentativas vencidos mesmo quando a BET chega antes do retry; rejeição e evento únicos, sem crédito.
- HTTP 409 para chave reutilizada com outra wallet inexistente.
- Índice da migration 003 e reversão up/down/up.
- Publicação mais lenta que o lease de 1 segundo, enquanto outro publisher tenta assumir a mesma linha. O transporte lento aguarda 1,4 segundo e depois usa SQS real.
- Perda de token induzida no banco: o dono antigo não sobrescreve a confirmação do novo publisher.
- Três entregas SQS concorrentes do mesmo evento: a inbox e a projeção do consumidor de referência participam da mesma transação; o efeito é aplicado uma única vez.

O teste de shutdown está na suíte de concorrência: uma conexão mantém o lock da wallet; após observar o consumer bloqueado no PostgreSQL, o teste envia SIGTERM, verifica readiness 503, libera o lock e confere saída normal, ack, inbox, saldo, versão e ledger.

As falhas de transporte e de posse são injetadas explicitamente, sem substituir PostgreSQL nem SQS por mocks. Esses cenários e as alterações de recuperação passaram na execução completa registrada em VERIFICATION.md.

## Configuração e classificação de falhas

A unidade valida os cinco parâmetros de recuperação, limites do serviço, falha de inicialização antes da conexão, causas encapsuladas e decisões de retry/DLQ. Testes locais do consumidor conferem que falhas transitórias/desconhecidas não recebem ack antecipado e que a falha no envio à DLQ impede a exclusão da origem. Esses testes usam doubles; integração e concorrência continuam usando PostgreSQL/SQS reais.

As regressões de causas circulares rodam em processos filhos com timeout para que um loop no classificador não trave a suíte. Também há cadeias longas, erros encapsulados, precedência entre causas e um teste do consumidor com visibilidade de um segundo, verificando renovação antes da expiração e encerramento do heartbeat após o ack.

As regressões de ciclo de vida mantêm uma renovação pendente durante retry, sucesso e DLQ. Conferem que ela termina antes do backoff/ack, que não há renovações simultâneas nem posteriores à conclusão e que falha ou cancelamento por timeout não impedem a finalização. São seis testes locais com transporte controlado em `test/unit/visibility-lifecycle.test.ts`.

O teste `test/unit/http-bootstrap.test.ts` inicializa o módulo Nest com o controller real e uma aplicação de teste injetada, sem PostgreSQL/SQS. Ele cobre a resolução de imports e os metadados de decorators no Bun; não substitui os testes HTTP em containers. Os testes de processo verificam que falhas de inicialização exibem o stderr e que timeouts encerram o processo filho. Os 170 testes de unidade, 22 de integração e 24 de concorrência passaram na execução completa registrada em VERIFICATION.md.
