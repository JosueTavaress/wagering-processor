# Verificação

**Typecheck e 229 testes aprovados em containers em 16/10/2026, sem falhas.**

Resultado da execução com rebuild realizada pelo autor no Ubuntu/WSL e enviada nesta revisão:

| Verificação                   | Resultado                                              |
| ----------------------------- | ------------------------------------------------------ |
| Typecheck                     | Aprovado                                               |
| Unidade                       | 179 passaram · 0 falhas                                |
| Integração com PostgreSQL/SQS | 26 passaram · 0 falhas                                 |
| Concorrência entre processos  | 24 passaram · 0 falhas                                 |
| **Total**                     | **229 passaram · 0 falhas**                            |
| Carga                         | Experimento implementado; sem resultados de desempenho |

Ambiente: Bun 1.2.23, PostgreSQL 16.8 e LocalStack 4.2.0. A integração inclui os dois cenários de corte de conexão TCP: PostgreSQL indisponível durante reentregas sem débito duplicado e SQS indisponível durante retries da outbox, com publicação após recuperação. Os logs de falha e retry desses cenários fazem parte da execução esperada.

A saída completa foi enviada pelo autor na conversa; não está sendo atribuída a um arquivo de log local. A tentativa anterior de Docker neste ambiente não teve acesso ao socket; a execução posterior enviada pelo autor comprova a suíte completa.

O experimento `bun run test:load` permanece sem execução validada: a tentativa local falhou antes da carga por `ECONNREFUSED 127.0.0.1:5432`. Não há números de throughput ou percentis aprovados; execute conforme [docs/LOAD_TESTING.md](docs/LOAD_TESTING.md).

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
