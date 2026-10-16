import { randomUUID } from "node:crypto";
import { cpus, platform, release, totalmem } from "node:os";
import { connect } from "../src/infra/database/Database";
import { Money } from "../src/domain/entity/Money";

type Wallet = { id: string; playerId: string };
type Reconciliation = {
  consistent: boolean;
  storedBalance: { amount: string };
  checkedEntries: number;
};

function positiveInteger(name: string, fallback: number, maximum: number) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}
function percentile(samples: number[], fraction: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}
function latencies(samples: number[]) {
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
}
const requests = positiveInteger("LOAD_REQUESTS", 300, 100000);
const concurrency = positiveInteger("LOAD_CONCURRENCY", 8, 100);
const walletCount = positiveInteger("LOAD_WALLETS", 8, 100);
const drainTimeoutMs = positiveInteger("LOAD_DRAIN_TIMEOUT_MS", 30000, 300000);
const urls = (
  process.env.LOAD_API_URLS ??
  "http://localhost:3000,http://localhost:3001,http://localhost:3002"
)
  .split(",")
  .map((value) => new URL(value).origin);
const initialBalance = Money.from({ amount: "1000000.00", currency: "BRL" });
const db = await connect();

async function http(base: string, path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
async function lockConflicts() {
  const samples = await Promise.all(
    urls.map(async (base) => {
      const response = await http(base, "/metrics");
      if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
      const sample = (await response.text()).match(
        /^wager_lock_conflicts_total\s+(\S+)/m,
      );
      if (!sample || !Number.isFinite(Number(sample[1])))
        throw new Error("Missing lock-conflict metric");
      return Number(sample[1]);
    }),
  );
  return samples.reduce((sum, value) => sum + value, 0);
}
async function phase(name: string, count: number) {
  const wallets: Wallet[] = [];
  for (let index = 0; index < count; index++) {
    const response = await http(urls[index % urls.length]!, "/wallets", {
      playerId: randomUUID(),
      initialBalance: initialBalance.toJSON(),
    });
    if (response.status !== 201)
      throw new Error(`Wallet creation HTTP ${response.status}`);
    wallets.push((await response.json()) as Wallet);
  }
  const ids = wallets.map((wallet) => wallet.id);
  const placeholders = ids.map(() => "?").join(",");
  async function outbox() {
    const [row] = await db.em
      .fork()
      .execute<{ pending: string; lag: string }[]>(
        `select count(*)::text pending,coalesce(extract(epoch from now()-min(occurred_at)),0)::text lag
       from outbox where published_at is null and aggregate_id in (${placeholders})`,
        ids,
      );
    return {
      pending: Number(row!.pending),
      lagSeconds: Math.max(0, Number(row!.lag)),
    };
  }
  async function reconciliationPlan() {
    const [row] = await db.em
      .fork()
      .execute<{ "QUERY PLAN": { "Execution Time": number }[] }[]>(
        `explain (analyze,format json) select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0)
       from wallet_ledger where wallet_id=?`,
        [wallets[0]!.id],
      );
    return row!["QUERY PLAN"][0]!["Execution Time"];
  }
  async function submit(index: number) {
    const wallet = wallets[index % wallets.length]!;
    const external = randomUUID();
    return http(
      urls[index % urls.length]!,
      "/wagering/transactions",
      {
        providerId: "load",
        externalTransactionId: external,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: external,
        gameId: "load",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      },
      `load:${external}`,
    );
  }
  const warmupRequests = 10;
  for (let index = 0; index < warmupRequests; index++) {
    const response = await submit(index);
    if (response.status !== 200)
      throw new Error(`Warmup HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  const baselinePlanMs = await reconciliationPlan();
  const baselineLocks = await lockConflicts();
  const durations: number[] = [];
  const statuses: Record<string, number> = {};
  let next = 0,
    errors = 0,
    lagSamples = 0,
    samplingErrors = 0,
    peakLagSeconds = 0;
  let sampling: Promise<void> | undefined;
  async function sampleLag() {
    const sample = await outbox();
    peakLagSeconds = Math.max(peakLagSeconds, sample.lagSeconds);
    lagSamples++;
  }
  await sampleLag();
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = sampleLag()
      .catch(() => {
        samplingErrors++;
      })
      .finally(() => {
        sampling = undefined;
      });
  }, 1000);
  const start = performance.now();
  let elapsedMs: number;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < requests) {
          const index = next++;
          const requestStart = performance.now();
          try {
            const response = await submit(index);
            const result = (await response.json()) as {
              status?: string;
              idempotentReplay?: boolean;
            };
            statuses[response.status] = (statuses[response.status] ?? 0) + 1;
            if (
              response.status !== 200 ||
              result.status !== "PROCESSED" ||
              result.idempotentReplay !== false
            )
              errors++;
          } catch {
            statuses.networkError = (statuses.networkError ?? 0) + 1;
            errors++;
          } finally {
            durations[index] = performance.now() - requestStart;
          }
        }
      }),
    );
    elapsedMs = performance.now() - start;
  } finally {
    clearInterval(timer);
    await sampling;
  }
  await sampleLag();
  const locks = await lockConflicts();
  const finalPlanMs = await reconciliationPlan();
  const reconciliations = [];
  for (const wallet of wallets) {
    const response = await http(
      urls[0]!,
      `/wallets/${wallet.id}/reconciliation`,
      {},
    );
    if (!response.ok) throw new Error(`Reconciliation HTTP ${response.status}`);
    const result = (await response.json()) as Reconciliation;
    const [row] = await db.em
      .fork()
      .execute<
        { count: string }[]
      >("select count(*)::text count from wager_transactions where wallet_id=? and kind='BET' and status='PROCESSED'", [wallet.id]);
    const processed = Number(row!.count);
    const [walletState] = await db.em
      .fork()
      .execute<
        { version: number }[]
      >("select version from wallets where id=?", [wallet.id]);
    const expected = initialBalance.subtract(
      Money.from({ amount: `${BigInt(row!.count)}.00`, currency: "BRL" }),
    );
    if (
      !result.consistent ||
      result.storedBalance.amount !== expected.toString() ||
      result.checkedEntries !== processed + 1 ||
      walletState!.version !== processed + 1
    )
      throw new Error(`Financial invariant failed for wallet ${wallet.id}`);
    reconciliations.push({
      walletId: wallet.id,
      processed,
      version: walletState!.version,
      checkedEntries: result.checkedEntries,
      consistent: true,
    });
  }
  const processedTotal = reconciliations.reduce(
    (sum, wallet) => sum + wallet.processed,
    0,
  );
  if (
    processedTotal < requests - errors + warmupRequests ||
    processedTotal > requests + warmupRequests
  )
    throw new Error(
      "Accepted operations missing from persistence or unexpected extra operations",
    );
  const drainStart = performance.now();
  let remaining = await outbox();
  lagSamples++;
  peakLagSeconds = Math.max(peakLagSeconds, remaining.lagSeconds);
  while (
    remaining.pending > 0 &&
    performance.now() - drainStart < drainTimeoutMs
  ) {
    await Bun.sleep(500);
    remaining = await outbox();
    lagSamples++;
    peakLagSeconds = Math.max(peakLagSeconds, remaining.lagSeconds);
  }
  const window = Math.max(1, Math.floor(durations.length / 3));
  return {
    name,
    wallets: count,
    warmupRequests,
    requests,
    concurrency,
    elapsedMs,
    requestsPerSecond: requests / (elapsedMs / 1000),
    errors,
    errorRate: errors / requests,
    errorRatePercent: (100 * errors) / requests,
    statuses,
    latency: latencies(durations),
    firstThirdLatency: latencies(durations.slice(0, window)),
    lastThirdLatency: latencies(durations.slice(-window)),
    lockConflicts: locks - baselineLocks,
    outbox: {
      peakObservedLagSeconds: peakLagSeconds,
      lagSamples,
      samplingErrors,
      remaining,
      drainElapsedMs: performance.now() - drainStart,
    },
    reconciliationQuery: {
      baselineExecutionMs: baselinePlanMs,
      finalExecutionMs: finalPlanMs,
      baselineEntries: 1 + Math.ceil(warmupRequests / count),
      finalEntries: reconciliations[0]!.checkedEntries,
      note: "Single EXPLAIN ANALYZE samples, not the full deferred-trigger cost",
    },
    reconciliations,
  };
}
try {
  const [postgres] = await db.em
    .fork()
    .execute<{ version: string }[]>("select version() version");
  const revision = Bun.which("git")
    ? Bun.spawnSync(["git", "rev-parse", "HEAD"], { stderr: "pipe" })
    : undefined;
  const worktree = Bun.which("git")
    ? Bun.spawnSync(["git", "status", "--porcelain"], { stderr: "pipe" })
    : undefined;
  const results = [
    await phase("hot-wallet", 1),
    await phase("distributed-wallets", walletCount),
  ];
  console.log(
    JSON.stringify(
      {
        occurredAt: new Date().toISOString(),
        environment: {
          bun: Bun.version,
          postgres: postgres!.version,
          revision:
            process.env.LOAD_REVISION ??
            (revision?.exitCode === 0
              ? revision.stdout.toString().trim()
              : null),
          workingTreeDirty:
            worktree?.exitCode === 0
              ? worktree.stdout.toString().trim().length > 0
              : null,
          label: process.env.LOAD_ENVIRONMENT ?? "unspecified",
          os: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
          apiUrls: urls,
        },
        methodology:
          "Closed-loop HTTP clients; fresh wallets; 10 sequential warmups per phase; distinct 1.00 BRL bets; first/last thirds follow submission order; outbox sampled every second; no target RPS",
        results,
      },
      null,
      2,
    ),
  );
  if (
    results.some(
      (result) =>
        result.errors > 0 ||
        result.outbox.remaining.pending > 0 ||
        result.outbox.samplingErrors > 0,
    )
  )
    process.exitCode = 1;
} finally {
  await db.close(true);
}
