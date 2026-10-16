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

Ambiente: Bun 1.2.23, PostgreSQL 16.8 e LocalStack 4.2.0. A execução valida o código atual, incluindo o teste de recuperação após falha transitória: polls com prazo limitado até o commit, saldo esperado, débito único, inbox concluída e eventos. Também passaram os cenários de heartbeat, cancelamento SQL e recuperação dos publishers.

A saída completa desta execução foi enviada pelo autor na conversa; não está sendo atribuída a um arquivo de log local sem conferência. As limitações de escala e rede continuam documentadas em ARCHITECTURE.md.

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
