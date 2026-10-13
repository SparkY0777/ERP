import { integer, pgSchema, primaryKey, uuid } from 'drizzle-orm/pg-core';

const schema = pgSchema('fees');
export const accounts = schema.table('accounts', {
  tenantId: uuid('tenant_id').notNull(),
  studentId: uuid('student_id').notNull(),
  chargedMinor: integer('charged_minor').notNull(),
  paidMinor: integer('paid_minor').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.tenantId, table.studentId] })]);

export const payments = schema.table('payments', {
  tenantId: uuid('tenant_id').notNull(),
  paymentId: uuid('payment_id').notNull(),
  studentId: uuid('student_id').notNull(),
  amountMinor: integer('amount_minor').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.paymentId] })]);

export const initialMigration = ['CREATE SCHEMA fees', `
  CREATE TABLE fees.accounts (
    tenant_id uuid NOT NULL, student_id uuid NOT NULL,
    charged_minor integer NOT NULL CHECK (charged_minor > 0),
    paid_minor integer NOT NULL DEFAULT 0 CHECK (paid_minor >= 0 AND paid_minor <= charged_minor),
    PRIMARY KEY (tenant_id, student_id)
  );
`, `
  CREATE TABLE fees.payments (
    tenant_id uuid NOT NULL, payment_id uuid NOT NULL, student_id uuid NOT NULL,
    amount_minor integer NOT NULL CHECK (amount_minor > 0),
    PRIMARY KEY (tenant_id, payment_id),
    FOREIGN KEY (tenant_id, student_id) REFERENCES fees.accounts (tenant_id, student_id)
  );
`];
