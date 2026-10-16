# Verificação

**Typecheck e 227 testes aprovados em containers em 16/10/2026, sem falhas.**

Resultado da execução com rebuild realizada pelo autor no Ubuntu/WSL e enviada nesta revisão:

| Verificação                   | Resultado                                |
| ----------------------------- | ---------------------------------------- |
| Typecheck                     | Aprovado                                 |
| Unidade                       | 179 passaram · 0 falhas                  |
| Integração com PostgreSQL/SQS | 24 passaram · 0 falhas                   |
| Concorrência entre processos  | 24 passaram · 0 falhas                   |
| **Total**                     | **227 passaram · 0 falhas**              |
| Formatação                    | Aprovada separadamente em execução local |

Ambiente: Bun 1.2.23, PostgreSQL 16.8 e LocalStack 4.2.0. A execução inclui a métrica da DLQ independente do consumo, o heartbeat sem renovações acumuladas, o cancelamento SQL de renovação bloqueada e a proteção contra confirmação/retry pelo antigo proprietário do lease.

Os critérios de verificação definidos para este fechamento foram satisfeitos. As limitações de escala e rede continuam documentadas em ARCHITECTURE.md.

## Como repetir

```bash
docker compose --profile test run --build --rm tests
```

Para guardar a saída no Bash/WSL:

```bash
mkdir -p docs/verification
set -o pipefail
docker compose --profile test run --build --rm tests 2>&1 | tee "docs/verification/tests-$(date +%Y%m%d-%H%M%S).log"
```

O rebuild é necessário para testar as alterações atuais. O comando deve terminar com código zero. Falha de build ou acesso ao Docker não representa execução dos testes.

A formatação é verificada separadamente com `bun run format:check`.

Decisões em [ARCHITECTURE.md](ARCHITECTURE.md) e cobertura em [docs/TESTING.md](docs/TESTING.md). Os testes verificam correção nos cenários exercitados; não são benchmark nem certificação para produção.
