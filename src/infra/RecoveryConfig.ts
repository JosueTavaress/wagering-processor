export const ProcessSignal = {
  Terminate: "SIGTERM",
  Interrupt: "SIGINT",
  Kill: "SIGKILL",
} as const;
export const ListenHost = "0.0.0.0";
export const WorkerRole = {
  All: "all",
  Consumer: "consumer",
  Publisher: "publisher",
  Reference: "reference",
} as const;
export const RuntimeEnvironment = {
  Test: "test",
} as const;
type Environment = Record<string, string | undefined>;

function positiveInteger(
  env: Environment,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (raw !== undefined && !/^[0-9]+$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(
      `Invalid configuration: ${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

export function readRecoveryConfig(env: Environment = process.env) {
  return {
    referenceTTL: positiveInteger(env, "REFERENCE_TTL_MS", 300000),
    referenceAttempts: positiveInteger(env, "REFERENCE_MAX_ATTEMPTS", 10),
    outboxLeaseSeconds: positiveInteger(env, "OUTBOX_LEASE_SECONDS", 30, 86400),
    queueVisibilitySeconds: positiveInteger(
      env,
      "QUEUE_VISIBILITY_SECONDS",
      30,
      43200,
    ),
    maxReceiveCount: positiveInteger(env, "MAX_RECEIVE_COUNT", 5, 1000),
  };
}
