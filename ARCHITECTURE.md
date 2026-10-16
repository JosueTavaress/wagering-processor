# Arquitetura e decisões

Priorizei correção financeira e recuperação após falhas. HTTP, SQS e o worker de referências usam o mesmo caso de uso; saldo, ledger e eventos são persistidos juntos.

## Organização

- `domain`: Money, entidades, eventos e regras de negócio, sem dependências de NestJS, ORM ou AWS.
- `application`: casos de uso e portas para persistência e identidade do provedor.
- `infra`: HTTP, PostgreSQL, SQS, workers e composição das dependências.

Tipos e estados de transação, direção do ledger e códigos de falha têm definições compartilhadas no domínio. Filas, headers e identificadores operacionais ficam nos contratos da infraestrutura. As consultas SQL recebem esses valores como parâmetros; migrations mantêm seus valores versionados.

As consultas usam uma porta própria para evitar reconstruir agregados quando só preciso retornar dados. Mantive SQL explícito onde ele ajuda a conferir locks, deduplicação e leases.

## Dinheiro e persistência

Usei `bigint` em centavos no Money para manter a aritmética exata. Os contratos recebem e devolvem strings com duas casas; entradas negativas, notação científica e precisão excedente são rejeitadas. API e fila trabalham com BRL; o domínio também suporta USD e EUR e testa conflitos de moeda.

Escolhi MikroORM pelo controle explícito do EntityManager e das transações. Cada operação usa `em.fork().transactional()`, com o mesmo EntityManager para todos os registros envolvidos. No PostgreSQL, valores ficam em `numeric` sem escala imposta pelo tipo, com CHECK de escala e finitude para rejeitar excesso de casas em vez de arredondá-lo. `ExactDecimalType` preserva strings na leitura e escrita do ORM.

## Concorrência e consistência

A unidade de lock é a wallet. Uso `PESSIMISTIC_WRITE` com READ COMMITTED: duas apostas de 80 contra saldo 100 são executadas em sequência naquela wallet; uma processa e a outra encontra saldo 20 e é rejeitada. Wallets diferentes podem avançar em paralelo. A versão começa em 1 e só aumenta quando o saldo muda.

O fluxo é: pré-checar identidade → bloquear wallet → reler identidade → validar e aplicar → gravar transação, saldo, ledger, inbox e outbox → commit. A pré-checagem identifica conflitos mesmo quando o payload aponta para uma wallet inexistente; a releitura após o lock preserva a decisão concorrente. Deadlocks e conflitos de lock/serialização permitem até três retries da transação inteira, com backoff e jitter.

O schema reforça as garantias com unicidade de wallet por jogador/moeda, chave idempotente, identidade externa, lançamento por transação/wallet e reversão por referência/tipo. Checks e triggers protegem saldo não negativo, aritmética, direção e continuidade do ledger, estados terminais e imutabilidade dos lançamentos, inclusive contra UPDATE, DELETE e TRUNCATE.

No commit, constraints diferidas conferem o saldo contra a soma do ledger. Escolhi essa proteção para tornar a consistência verificável no banco. O custo cresce com o histórico da wallet; em produção, mediria esse custo antes de avaliar uma validação incremental. A reconciliação também bloqueia a wallet e sinaliza divergências por resposta, log e métrica, sem corrigi-las silenciosamente.

## Idempotência e referências

O header `Idempotency-Key` é obrigatório e tem unicidade global. A identidade `(providerId, externalTransactionId)` também é única. Outra chave para a mesma identidade, ou a mesma chave com outro payload, resulta em conflito.

O hash é SHA-256 do JSON dos campos de negócio, com chaves ordenadas recursivamente, campos ausentes omitidos e ordem de arrays preservada. Chave idempotente e metadados de transporte ficam fora desse hash. O resultado guarda status, failureCode e saldo observado; o replay retorna esse resultado, sem recalcular pelo saldo atual.

Referências são resolvidas por provedor/id externo e precisam corresponder a jogador, wallet, moeda e rodada. Se ainda não existem ou estão pendentes, a operação fica em `PENDING_REFERENCE`. O worker usa backoff de 1 a 60 segundos, com limite configurável de 10 tentativas ou 5 minutos. Esse prazo limita a espera por mensagens atrasadas sem manter pendências indefinidamente. Esgotado o limite, rejeita com `REFERENCE_EXPIRED` e gera evento, mesmo que a referência tenha chegado tarde.

Transições válidas: `PENDING` pode ir para `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`; `PENDING_REFERENCE` pode continuar pendente ou chegar a um desses estados terminais. Um terminal não muda mais. `rehydrate` reconstrói o estado persistido sem reaplicar transições. Falhas de infraestrutura antes de aceitar uma operação são auditadas em `failed_messages`/DLQ; não criam uma transação financeira fictícia em FAILED.

Adotei estas interpretações:

- LOSS exige zero e não muda saldo, versão ou ledger. As demais operações externas exigem valor positivo.
- OPENING é interno; saldo inicial positivo gera crédito e eventos na criação, mantendo versão 1.
- WIN pode não ter referência; quando tem, exige BET processada da mesma rodada, com prêmio livre.
- BET e LOSS não aceitam referência. REFUND só reverte BET; ROLLBACK reverte BET, WIN ou REFUND, sempre pelo valor integral.
- Uma BET pode receber um REFUND e um ROLLBACK, seguindo a restrição do enunciado por tipo. Confirmaria essa interpretação com negócio antes de uso em produção.

## Mensageria e recuperação

A inbox deduplica por `(consumerName, messageId)` e verifica o hash do comando, incluindo a chave idempotente. Seu registro participa da transação financeira. O consumidor só dá ack depois do commit; se morrer antes do ack, a reentrega retorna o resultado persistido.

Falhas transitórias reconhecidas recebem retry com backoff e limite de tentativas. Mensagens inválidas, conflitos de domínio, bugs reconhecidos e falhas permanentes de infraestrutura vão para DLQ sem retries inúteis. Falhas desconhecidas também têm retry limitado, mas terminam com `UNKNOWN_FAILURE_RETRIES_EXHAUSTED`, sem serem apresentadas como indisponibilidade confirmada. Logs preservam a categoria e o código/nome da causa, sem gravar mensagens de erro ou payloads completos. As causas são percorridas sem recursão e com proteção contra ciclos. A precedência é: erro de programação, domínio, mensagem inválida, infraestrutura permanente, transitória e desconhecida; o diagnóstico identifica a causa escolhida. O envio à DLQ precede a exclusão da origem. O redrive nativo também pode encaminhar mensagens durante indisponibilidade prolongada do banco. Em SIGTERM, o worker deixa de ficar pronto, interrompe novos polls e aguarda o trabalho em andamento, mantendo a visibilidade por heartbeat a cada terço do prazo, inclusive quando a visibilidade é de um segundo.

O consumidor mantém no máximo uma renovação de visibilidade em andamento. Antes do retry ou ack, interrompe novos disparos e aguarda a chamada pendente, evitando que um heartbeat antigo sobrescreva o backoff. Cada renovação usa cancelamento por timeout (um terço da visibilidade, limitado a 10 segundos); se falhar, a reentrega continua protegida pela idempotência.

A outbox guarda eventos na mesma transação do saldo. Publishers selecionam trabalho com `FOR UPDATE SKIP LOCKED`, usam lease de 30 segundos renovável e só confirmam/reagendam com o próprio token. Se o processo morrer após o commit, outro publica; se morrer após enviar e antes de confirmar, pode haver publicação duplicada. **O consumidor deve deduplicar persistentemente por eventId.** O teste downstream demonstra isso com SQS e inbox SQL reais.

Eventos têm subclasses concretas, versão e envelope estável, com valores monetários em strings. Não há garantia de ordem absoluta entre publishers; `walletVersion` permite identificar desordem. A outbox tenta novamente com backoff até 60 segundos, sem descartar eventos por limite de tentativas.

## Erros e diagnóstico

| HTTP      | Significado                            |
| --------- | -------------------------------------- |
| 200 / 201 | Consulta/processamento / wallet criada |
| 202       | Processamento pendente                 |
| 400       | Contrato, header ou cursor inválido    |
| 404       | Recurso inexistente                    |
| 409       | Conflito de identidade ou unicidade    |
| 422       | Rejeição de negócio persistida         |
| 500       | Erro interno ou de programação         |
| 503       | Falha transitória, com Retry-After     |

Rejeições carregam códigos estáveis:

| Código                                         | Motivo                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `INSUFFICIENT_FUNDS`                           | BET sem saldo                                      |
| `REVERSAL_INSUFFICIENT_FUNDS`                  | Reversão debitaria além do saldo                   |
| `PLAYER_MISMATCH` / `CURRENCY_MISMATCH`        | Operação incompatível com a wallet                 |
| `REFERENCE_MISMATCH`                           | Identidade ou rodada incompatível                  |
| `INVALID_REFERENCE` / `INVALID_REFERENCE_KIND` | Referência inválida ou tipo não permitido          |
| `REFERENCE_AMOUNT_MISMATCH`                    | Reversão com valor diferente                       |
| `REFERENCE_NOT_PROCESSED`                      | Referência terminal sem processamento bem-sucedido |
| `ALREADY_REVERSED`                             | Reversão desse tipo já aplicada                    |
| `REFERENCE_EXPIRED`                            | Prazo ou tentativas esgotados                      |

Reenviar uma rejeição com a mesma chave preserva o resultado. Payload corrigido representa uma nova operação, com nova identidade. Em falhas transitórias, a mesma chave deve ser reutilizada.

Logs JSON carregam os identificadores disponíveis, sem payload financeiro completo. Métricas cobrem status, duplicatas, retries, DLQ, conflitos de lock, atraso da outbox, latência e divergências. Liveness verifica o processo; readiness verifica PostgreSQL e SQS. O ledger usa cursor base64url de wallet/sequence, com paginação por sequência e validação do intervalo bigint.

## Configuração de recuperação

TTL, tentativas, lease e visibilidade são validados antes de abrir conexões. Exigem inteiros positivos e seguros; valores vazios, NaN, infinito, fracionários ou negativos impedem a inicialização com o nome da variável no erro. Visibilidade respeita o limite de 43.200 segundos, redrive de 1.000 tentativas e lease de até 86.400 segundos. O lease tem esse teto para limitar o tempo de retomada após crash. Workers mantêm os valores validados na criação; mudanças exigem reinício.

## Autenticação e limites

Optei por não implementar autenticação para concentrar o escopo nas garantias financeiras, conforme permitido. `ProviderIdentityPort` é o ponto de extensão e `DemoProviderIdentity` é permissivo. Integraria um IdP OIDC, como Keycloak, validando assinatura por JWKS, issuer, audience e vínculo entre o provedor e o token. Criação e consultas também precisariam de autorização. Health permanece público; mensagens internas continuam sujeitas às validações de domínio.

As migrations são versionadas e reversíveis; `migrate down` reverte a última aplicada. Reverter a inicial remove os dados. Não há benchmark de carga nem simulação de todas as falhas de rede. Resultados em [VERIFICATION.md](VERIFICATION.md); cobertura em [docs/TESTING.md](docs/TESTING.md).
