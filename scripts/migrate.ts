import { connect } from "../src/infra/database/Database";
const db = await connect();
const directory = new URL("../migrations/", import.meta.url).pathname;
try {
  await db.em.fork().transactional(async (em) => {
    await em.execute("select pg_advisory_xact_lock(912346)");
    await em.execute(
      "create table if not exists schema_migrations(version text primary key,applied_at timestamptz not null default now())",
    );
    const applied = await em.execute<{ version: string }[]>(
      "select version from schema_migrations order by version",
    );
    const files = Array.from(
      new Bun.Glob("*.up.sql").scanSync(directory),
    ).sort();
    if (process.argv.includes("down")) {
      const latest = applied.at(-1)?.version;
      const file = files.find((name) => name.split("_")[0] === latest);
      if (latest) {
        if (!file) throw new Error(`Missing migration: ${latest}`);
        await em.execute(
          await Bun.file(
            directory + file.replace(".up.sql", ".down.sql"),
          ).text(),
        );
        await em.execute("delete from schema_migrations where version=?", [
          latest,
        ]);
      }
    } else {
      for (const file of files) {
        const version = file.split("_")[0]!;
        if (applied.some((row) => row.version === version)) continue;
        await em.execute(await Bun.file(directory + file).text());
        await em.execute("insert into schema_migrations(version) values (?)", [
          version,
        ]);
      }
    }
  });
  console.log("Migrations complete");
} finally {
  await db.close(true);
}
