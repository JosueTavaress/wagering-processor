import { test, expect } from "bun:test";
import { waitForWorkerCrash } from "../helpers";

function child(source: string) {
  return Bun.spawn([process.execPath, "-e", source], {
    stdout: "ignore",
    stderr: "pipe",
  });
}

test("crash wait observes a real SIGKILL through exited", async () => {
  const worker = child('process.kill(process.pid, "SIGKILL")');
  await waitForWorkerCrash(worker);
  expect(worker.signalCode).toBe("SIGKILL");
});

test("crash wait rejects a normal exit", async () => {
  const worker = child("process.exit(0)");
  await expect(waitForWorkerCrash(worker)).rejects.toThrow(
    "Worker exited without the injected SIGKILL",
  );
});

test("crash wait terminates a child when the deadline expires", async () => {
  const worker = child("await Bun.sleep(60000)");
  await expect(waitForWorkerCrash(worker, 100)).rejects.toThrow(
    "WORKER_CRASH_TIMEOUT",
  );
  expect(worker.signalCode).toBe("SIGKILL");
});
