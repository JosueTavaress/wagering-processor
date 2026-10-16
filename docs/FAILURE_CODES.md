# Códigos e resposta do provedor

| Código                            | Significado                                                                 | Ação                                                          |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| INVALID_PAYLOAD                   | Header ausente, formato/escala/identificador/tipo inválido                  | Corrigir solicitação; não houve aceite financeiro             |
| INVALID_CURSOR                    | Cursor inválido ou de outra wallet                                          | Reiniciar consulta com cursor válido                          |
| WALLET_NOT_FOUND                  | Wallet inexistente                                                          | Corrigir wallet; API 404, mensagem inválida na fila vai à DLQ |
| TRANSACTION_NOT_FOUND             | Identidade consultada inexistente                                           | Conferir identificador/consultar posteriormente               |
| IDEMPOTENCY_CONFLICT              | Mesma chave com outro conteúdo ou outra chave para mesma identidade         | Investigar; não repetir cegamente                             |
| UNIQUENESS_CONFLICT               | Corrida de unicidade ou wallet duplicada                                    | Conferir identidade; consultar resultado existente            |
| INBOX_CONFLICT                    | messageId reutilizado para comando diferente                                | Corrigir produtor; DLQ                                        |
| PLAYER_MISMATCH                   | Player difere do dono da wallet                                             | Rejeição terminal                                             |
| CURRENCY_MISMATCH                 | Moeda incompatível                                                          | Rejeição terminal quando chega ao domínio                     |
| INSUFFICIENT_FUNDS                | Aposta sem saldo                                                            | Rejeição terminal; não reavaliada em replay                   |
| REVERSAL_INSUFFICIENT_FUNDS       | Reversão debitaria além do saldo                                            | Rejeição terminal auditável; intervenção de negócio           |
| INVALID_REFERENCE                 | Autorreferência/incompatibilidade estrutural                                | Corrigir comando                                              |
| REFERENCE_MISMATCH                | Provider/player/wallet/moeda/rodada incompatível                            | Rejeição terminal                                             |
| REFERENCE_NOT_PROCESSED           | Referência terminal rejeitada ou failed                                     | Rejeição terminal                                             |
| INVALID_REFERENCE_KIND            | Tipo de referência não permitido                                            | Rejeição terminal                                             |
| REFERENCE_AMOUNT_MISMATCH         | Reversão parcial ou valor diferente                                         | Rejeição terminal                                             |
| ALREADY_REVERSED                  | Referência já revertida por esse tipo                                       | Rejeição terminal                                             |
| REFERENCE_EXPIRED                 | Pendência esgotou TTL/tentativas, inclusive quando a referência chega tarde | Rejeição terminal; consultar e investigar origem              |
| INTERNAL_ERROR                    | Bug, erro SQL permanente ou falha interna não classificada como transitória | HTTP 500; investigar, sem retry automático cego               |
| INFRASTRUCTURE_UNAVAILABLE        | Falha de infraestrutura HTTP                                                | Retry com mesma chave, HTTP 503                               |
| INVALID_MESSAGE                   | Envelope SQS inválido                                                       | DLQ; corrigir produtor                                        |
| INFRASTRUCTURE_RETRIES_EXHAUSTED  | Limite de retries de uma falha transitória reconhecida atingido             | DLQ e auditoria; investigar antes de redrive                  |
| UNKNOWN_FAILURE_RETRIES_EXHAUSTED | Falha não classificada persistiu até o limite                               | DLQ e auditoria; investigar a causa antes de redrive          |
| PERMANENT_INFRASTRUCTURE_ERROR    | Autorização, credenciais ou erro SQL permanente reconhecido                 | DLQ sem retry; corrigir a causa antes de redrive              |
| PROGRAMMING_ERROR                 | Bug reconhecido durante o consumo                                           | DLQ sem retry; investigar a implementação                     |

`INVALID_MONEY`, `INVALID_AMOUNT`, `REFERENCE_REQUIRED` e `INVALID_INITIAL_BALANCE` são guards adicionais do domínio. O transporte rejeita esses formatos primeiro como INVALID_PAYLOAD.

`INVALID_TRANSACTION_STATE`, `UNBALANCED_LEDGER`, `NO_LEDGER_DIRECTION`, `INBOX_ALREADY_PROCESSED` e `MONEY_MUST_BE_STRING` indicam uso incorreto da implementação. Não são alternativas de negócio que autorizam continuar a operação; devem levar a rollback/investigação.

Uma rejeição persistida não deve ser “corrigida” alterando o payload sob a mesma chave. Consulte a operação original e trate uma eventual nova operação conforme o contrato do provedor.

Os códigos de programação listados acima retornam HTTP 500, sem Retry-After; não são rejeições financeiras persistidas. O consumidor também usa essa classificação para não confundir erro interno com payload permanentemente inválido. UNEXPECTED_REFERENCE é um guard de BET/LOSS; o transporte normalmente o apresenta como INVALID_PAYLOAD.

No consumidor, falhas desconhecidas recebem retry limitado. Falhas permanentes conhecidas vão diretamente à DLQ. Os logs registram `failureCategory`, `failureCode` e o código/nome da causa em `errorCode`, inclusive para causas encapsuladas. Uma falha ao enviar à DLQ impede o ack da origem.
