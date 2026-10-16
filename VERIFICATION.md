# Verificação

**Suíte completa aprovada em 16/10/2026: typecheck e 213 testes, sem falhas.**

| Verificação                     | Resultado                              |
| ------------------------------- | -------------------------------------- |
| Typecheck                       | Aprovado                               |
| Unidade                         | 167 passaram · 0 falhas                |
| Integração com PostgreSQL e SQS | 22 passaram · 0 falhas                 |
| Concorrência entre processos    | 24 passaram · 0 falhas                 |
| **Total**                       | **213 passaram · 0 falhas**            |
| Formatação com Prettier         | Aprovada em verificação local separada |

**Cenários críticos:** idempotência, disputa de saldo, múltiplos processos, atomicidade, referências fora de ordem, retry/DLQ, recuperação após crash, leases e SIGTERM. As regressões de configuração, causas circulares/encapsuladas e heartbeat pendente durante retry/ack também passaram. Cobertura detalhada em [docs/TESTING.md](docs/TESTING.md).

A execução completa foi realizada no Ubuntu/WSL, com Bun 1.2.23, PostgreSQL 16.8 e LocalStack 4.2.0 em containers reais. A saída foi compartilhada na revisão. A imagem de testes exibida foi `sha256:e00a5d600665587f62826b68ed72f73890b5aa8100be8bd772f9a57805b43776`. O log completo dessa execução aprovada e o commit correspondente ainda não estão arquivados no repositório.

**Limite da evidência:** os resultados comprovam os cenários exercitados nessa execução. Não são benchmark de carga; alterações no código exigem nova validação. O comando da suíte não inclui o check de formatação, executado separadamente e também configurado na CI.

## Como repetir

```bash
docker compose --profile test run --build --rm tests
```

Para guardar a saída no Bash/WSL:

```bash
mkdir -p docs/verification
set -o pipefail
docker compose --profile test run --build --rm tests 2>&1 | tee docs/verification/test-all-current.log
```

Se as imagens já estiverem disponíveis localmente, é possível repetir sem reconstruir ou baixar imagens:

```bash
mkdir -p docs/verification
set -o pipefail
docker compose --profile test run --rm --pull never tests 2>&1 | tee "docs/verification/tests-$(date +%Y%m%d-%H%M%S).log"
```

**Esse comando testa o código do último build.** Se houve alteração de código, restabeleça o acesso ao Docker Hub e execute novamente com `--build`. Caso falte alguma imagem local, também será necessário acesso à rede. Não associe o log de uma imagem antiga à validação de código novo.

Para conferir a formatação localmente, use `bun run format:check`.

Decisões em [ARCHITECTURE.md](ARCHITECTURE.md) e cobertura detalhada em [docs/TESTING.md](docs/TESTING.md).
