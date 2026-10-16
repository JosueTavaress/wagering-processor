# Como acompanhar o processamento

Este roteiro mostra o caminho de uma operação e onde conferir cada garantia no código.

## 1. Iniciar a aplicação

A [composição](../src/infra/composition.ts) valida as configurações de recuperação antes de abrir conexões. Depois cria banco, broker e casos de uso. HTTP e workers compartilham essa composição.

O domínio concentra as regras; a aplicação coordena a operação; a infraestrutura adapta HTTP, PostgreSQL e SQS. As decisões estão em [ARCHITECTURE.md](../ARCHITECTURE.md).

## 2. Criar uma wallet

O caso de uso [OpenWallet](../src/application/open-wallet/OpenWallet.ts) cria a wallet com versão 1. Se o saldo inicial for positivo, grava uma transação interna OPENING, um crédito no ledger e os eventos na outbox, tudo na mesma transação SQL.

O [Money](../src/domain/entity/Money.ts) representa valores em centavos com `bigint`. Os contratos usam strings decimais com duas casas.

## 3. Receber uma aposta

O [controller](../src/infra/http/ApiController.ts) valida o body e usa o header `Idempotency-Key` como chave. O [consumer](../src/infra/workers/WagerConsumer.ts) valida o envelope da fila. Ambos chamam [ProcessWagerTransaction](../src/application/process-wager-transaction/ProcessWagerTransaction.ts).

Uma requisição inválida não entra no fluxo financeiro. Uma mensagem inválida segue para DLQ, com diagnóstico.

## 4. Conferir identidade e bloquear a wallet

Dentro da Unit of Work, o caso de uso consulta a chave e a identidade externa. Payload diferente é conflito. Depois bloqueia a wallet e relê a identidade para decidir com o estado atualizado.

Se a operação já existe, retorna o resultado persistido, incluindo o saldo observado naquele processamento. Na entrada SQS, o registro de inbox também é conferido antes do commit.

O [repository de wallets](../src/infra/repository/PostgresWalletRepository.ts) usa lock pessimista por linha. Duas operações da mesma wallet aguardam uma à outra; wallets diferentes podem progredir em paralelo.

## 5. Validar referência e aplicar a regra

A [WagerPolicy](../src/domain/service/WagerPolicy.ts) confere jogador, moeda e referência. Referências precisam corresponder ao provedor, wallet, jogador, moeda e rodada.

- BET debita se houver saldo; WIN credita; LOSS registra o resultado sem movimentar saldo.
- REFUND e ROLLBACK validam tipo, valor integral e reversão anterior.
- Referência ausente ou ainda pendente deixa a operação em PENDING_REFERENCE. O worker retenta com backoff e rejeita quando o prazo ou as tentativas se esgotam.
- Rejeições são terminais e não geram lançamento financeiro.

A [Wallet](../src/domain/entity/Wallet.ts) aplica o movimento. Quando o saldo muda, a versão aumenta e o caso de uso cria um lançamento com saldo anterior, valor e saldo final.

## 6. Confirmar tudo junto

A [PostgresUnitOfWork](../src/infra/database/PostgresUnitOfWork.ts) fornece repositories vinculados ao mesmo EntityManager transacional. Transação, saldo, ledger, inbox e outbox são confirmados juntos. Uma falha antes do commit desfaz essas alterações.

As [migrations](../migrations) aplicam unicidade, saldo não negativo, ledger imutável, aritmética, direção e continuidade dos lançamentos. Constraints diferidas conferem a correspondência entre saldo e ledger no commit.

## 7. Dar ack e publicar eventos

Depois do commit, o consumer pode excluir a mensagem da origem. Antes do ack ou de ajustar a visibilidade para retry, ele interrompe novos heartbeats e aguarda a renovação pendente. Assim, uma chamada antiga não sobrescreve o backoff.

O [OutboxPublisher](../src/infra/workers/OutboxPublisher.ts) publica separadamente, usando seleção com SKIP LOCKED, lease renovável e token de posse. Se morrer após enviar e antes de confirmar a publicação, outro publisher pode enviar novamente. O eventId permanece estável; o consumidor do evento deve deduplicá-lo persistentemente.

## 8. Conferir recuperação e consistência

Se houver falha após commit e antes do ack, a reentrega encontra a operação já persistida. Falhas transitórias e desconhecidas têm retry limitado; falhas permanentes conhecidas seguem para DLQ. SIGTERM interrompe novos polls e aguarda o trabalho em andamento.

A reconciliação compara saldo armazenado e saldo reconstruído pelo ledger. Divergências aparecem na resposta, nos logs e em métrica, sem correção silenciosa.

Para conferir esses comportamentos, siga [docs/TESTING.md](TESTING.md). Os resultados da execução estão em [VERIFICATION.md](../VERIFICATION.md).
