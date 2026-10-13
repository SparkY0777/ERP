import { integer, pgSchema, primaryKey, uuid } from 'drizzle-orm/pg-core';

const schema = pgSchema('reporting');
export const enrolments = schema.table('enrolments', {
  tenantId: uuid('tenant_id').notNull(),
  studentId: uuid('student_id').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.studentId] })]);

export const collections = schema.table('collections', {
  tenantId: uuid('tenant_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  amountMinor: integer('amount_minor').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.paymentId] })]);

export const initialMigration = ['CREATE SCHEMA reporting', `
  CREATE TABLE reporting.enrolments (
    tenant_id uuid NOT NULL, student_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, student_id)
  );
`, `
  CREATE TABLE reporting.collections (
    tenant_id uuid NOT NULL, payment_id uuid NOT NULL,
    amount_minor integer NOT NULL CHECK (amount_minor > 0),
    PRIMARY KEY (tenant_id, payment_id)
  );
`];
