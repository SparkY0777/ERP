import { DynamicModule, Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { integer, pgSchema, PgDatabase, PgQueryResultHKT, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle as embeddedDrizzle } from 'drizzle-orm/pglite';
import { drizzle as serverDrizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { mkdir } from 'node:fs/promises';

export type SqlDatabase = PgDatabase<PgQueryResultHKT>;
export type Transaction = Parameters<Parameters<SqlDatabase['transaction']>[0]>[0];

const migrations = pgSchema('infrastructure').table('migrations', {
  module: text('module').notNull(), version: integer('version').notNull(),
}, (table) => [primaryKey({ columns: [table.module, table.version] })]);

export interface DatabaseOptions {
  databaseUrl?: string;
  dataDir?: string;
}

export class Database implements OnApplicationShutdown {
  constructor(readonly db: SqlDatabase, private readonly close: () => Promise<void>) {}

  async migrate(module: string, version: number, statements: readonly string[]) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(873210)`);
      const applied = await tx.select().from(migrations)
        .where(and(eq(migrations.module, module), eq(migrations.version, version)));
      if (applied.length) return;
      for (const statement of statements) await tx.execute(sql.raw(statement));
      await tx.execute(sql`INSERT INTO infrastructure.migrations (module, version) VALUES (${module}, ${version})`);
    });
  }

  async onApplicationShutdown() { await this.close(); }
}

async function connect(options: DatabaseOptions): Promise<Database> {
  const databaseUrl = options.databaseUrl ?? (options.dataDir === undefined ? process.env.DATABASE_URL : undefined);
  if (databaseUrl && options.dataDir !== undefined) throw new Error('Choose databaseUrl or dataDir, not both');
  if (!databaseUrl && process.env.NODE_ENV === 'production') throw new Error('Production requires DATABASE_URL');
  let database: Database;
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    database = new Database(serverDrizzle(pool), () => pool.end());
  } else {
    // shortcut: embedded PostgreSQL supports one process per data directory; use DATABASE_URL for multiple processes.
    const dataDir = options.dataDir ?? './data/postgres';
    if (dataDir !== 'memory://') await mkdir(dataDir, { recursive: true });
    const client = await PGlite.create(dataDir);
    database = new Database(embeddedDrizzle(client), () => client.close());
  }
  try {
    await database.db.execute(sql`CREATE SCHEMA IF NOT EXISTS infrastructure`);
    await database.db.execute(sql`
      CREATE TABLE IF NOT EXISTS infrastructure.migrations (
        module text NOT NULL, version integer NOT NULL, PRIMARY KEY (module, version)
      )
    `);
    return database;
  } catch (error) {
    await database.onApplicationShutdown();
    throw error;
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: Database, useFactory: () => connect(options) }],
      exports: [Database],
    };
  }
}
