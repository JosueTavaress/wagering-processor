import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OutboxPublisher } from "../../src/infra/workers/OutboxPublisher";
import type { Database } from "../../src/infra/database/Database";
import type { SqsBroker } from "../../src/infra/messaging/SqsBroker";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

for (const publication of ["success", "retry"] as const) {
  for (const renewal of ["renewed", "lost", "failed"] as const) {
    test(`publisher ${publication} drains ${renewal} renewal without overlapping or queued heartbeats`, async () => {
      const previousLease = process.env.OUTBOX_LEASE_SECONDS;
      process.env.OUTBOX_LEASE_SECONDS = "30";
      const publishing = signal(),
        finishPublication = signal();
      const renewing = signal(),
        finishRenewal = signal();
      const id = randomUUID();
      let renewals = 0;
      let fire!: () => void;
      let stopped = false;
      const writes: { sql: string; params: unknown[] }[] = [];
      const timeoutSettings: unknown[][] = [];
      let claimToken: unknown;
      const timer = spyOn(globalThis, "setInterval").mockImplementation(((
        callback: () => void,
      ) => {
        fire = callback;
        return 1;
      }) as unknown as typeof setInterval);
      const clear = spyOn(globalThis, "clearInterval").mockImplementation(
        () => {
          stopped = true;
        },
      );
      const em = {
        transactional: async (work: (manager: unknown) => Promise<unknown>) =>
          work(em),
        execute: async (sql: string, params: unknown[] = []) => {
          if (sql.startsWith("with due")) {
            claimToken = params[0];
            return [
              {
                id,
                aggregate_id: randomUUID(),
                event_type: "event",
                payload: { eventId: id },
                occurred_at: new Date(),
                attempts: 0,
                next_attempt_at: new Date(),
              },
            ];
          }
          if (sql.includes("set_config")) {
            timeoutSettings.push(params);
            return [];
          }
          if (sql.includes("returning id")) {
            renewals++;
            renewing.resolve();
            await finishRenewal.promise;
            if (renewal === "failed") throw new Error("database unavailable");
            return renewal === "renewed" ? [{ id }] : [];
          }
          if (sql.startsWith("update outbox")) {
            expect(stopped).toBe(true);
            writes.push({ sql, params });
            return [];
          }
          return [{ age: "0" }];
        },
      };
      const db = { em: { fork: () => em } } as unknown as Database;
      const broker = {
        publish: async (_body: string, _group: string, eventId: string) => {
          expect(eventId).toBe(id);
          publishing.resolve();
          await finishPublication.promise;
          if (publication === "retry") throw new Error("send failed");
        },
      } as unknown as SqsBroker;
      const pending = new OutboxPublisher(db, broker).tick();
      try {
        await publishing.promise;
        fire();
        await renewing.promise;
        for (let i = 0; i < 10; i++) fire();
        expect(renewals).toBe(1);
        finishPublication.resolve();
        // Advance promise continuations to the finalization boundary, without sleeping.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(stopped).toBe(true);
        expect(writes).toHaveLength(0);
        fire();
        expect(renewals).toBe(1);
        finishRenewal.resolve();
        expect(await pending).toBe(1);
        fire();
        expect(renewals).toBe(1);
        expect(timeoutSettings).toEqual([["10000ms", "10000ms"]]);
        if (renewal === "renewed") {
          expect(writes).toHaveLength(1);
          expect(writes[0]!.sql).toContain("where id=? and lease_token=?");
          expect(writes[0]!.sql).toContain(
            publication === "success" ? "published_at=?" : "next_attempt_at=?",
          );
          expect(writes[0]!.params.at(-1)).toBe(claimToken);
        } else {
          expect(writes).toHaveLength(0);
        }
      } finally {
        finishPublication.resolve();
        finishRenewal.resolve();
        await pending.catch(() => {});
        timer.mockRestore();
        clear.mockRestore();
        if (previousLease === undefined)
          delete process.env.OUTBOX_LEASE_SECONDS;
        else process.env.OUTBOX_LEASE_SECONDS = previousLease;
      }
    });
  }
}
