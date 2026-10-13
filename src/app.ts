import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromDrizzle, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { FeesModule } from './modules/fees';
import { SisModule } from './modules/sis';
import { ReportingModule } from './modules/reporting';
import { Database, DatabaseModule, DatabaseOptions } from './shared/database';

export interface AppOptions extends DatabaseOptions {
  relayEnabled?: boolean;
}

export async function createApp(logger: false | undefined = undefined, options: AppOptions = {}) {
  @Module({
    imports: [
      DatabaseModule.forRoot(options),
      CqrsModule.forRoot(),
      OutboxModule.forRoot({
        relay: { enabled: options.relayEnabled ?? process.env.OUTBOX_RELAY !== 'off', pollInterval: '1s' },
        retry: { attempts: 10, backoff: { delay: '1s', maxDelay: '1m' } },
      }),
      FeesModule, SisModule, ReportingModule,
    ],
    providers: [{
      provide: PostgresOutboxStore,
      inject: [Database, OutboxStorage],
      // shortcut: auto-migrations suit this demo; run explicit migrations before production deployments.
      useFactory: (database: Database, storage: OutboxStorage) =>
        new PostgresOutboxStore({ executor: fromDrizzle(database.db), migrate: true }, storage),
    }],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }));
  app.enableShutdownHooks();
  return app;
}
