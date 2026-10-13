import { pgSchema, primaryKey, uuid, varchar } from 'drizzle-orm/pg-core';

export const students = pgSchema('sis').table('students', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const initialMigration = ['CREATE SCHEMA sis', `
  CREATE TABLE sis.students (
    tenant_id uuid NOT NULL, id uuid NOT NULL,
    name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
    PRIMARY KEY (tenant_id, id)
  );
`];
