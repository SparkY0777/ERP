# School ERP: persistent modular monolith proof

One NestJS application with SIS, Fees, and Reporting. Modules own their data and expose facades, commands, queries, and events. Version 0.2 adds PostgreSQL persistence, a transactional outbox, and transactional consumer inboxes.

## Objective and result

The first version proved module boundaries using maps. This version proves that saving business data and recording its event happen together, and that consumers can recover after failure or restart.

- SIS saves students in `sis.students`.
- Fees saves accounts and idempotent payments in `fees.accounts` and `fees.payments`.
- Reporting owns `reporting.enrolments` and `reporting.collections`.
- NestJS outbox owns durable messages, inbox entries, retries, and dead letters in `nest_outbox`.
- Queries and commands still use local facades and `@nestjs/cqrs`.
- Events use the outbox's local transport. RabbitMQ is not installed in this phase.

## Run without installing a database server

Requires Node.js 22.12 or later. Node.js 24 is recommended and was used for verification.

```powershell
npm ci
npm test
npm start
```

The default database is **PGlite**, an embedded PostgreSQL engine inside Node.js. It persists to `./data/postgres` relative to the working directory. Start the app from this repository. No Docker, PostgreSQL service, database account, or manual table creation is needed.

The app creates the data folder and applies migrations on first startup. Restarting it reuses the same records. `data/` is ignored by Git. Never delete it to clear a temporary error; deleting it loses local records.

Embedded mode supports only one application process per data directory. Stop the API before running the outbox CLI against that same embedded database. It is a local proof, not a deployment database.

The HTTP server listens only at `http://127.0.0.1:3000`. `npm run dev` builds and starts once; restart after code changes.

## Use a normal PostgreSQL server

Set `DATABASE_URL` before starting the application. It switches from PGlite to the `pg` driver and connection pool, using the same Drizzle schema definitions and module code.

Optional Docker setup:

```powershell
docker compose up -d --wait
$env:DATABASE_URL = 'postgresql://erp:local-demo-only@127.0.0.1:5432/school_erp'
npm start
```

Docker must already be installed and running. The supplied Compose file exposes PostgreSQL on loopback and retains its files in a named volume. Its credentials are for a local demo only. No external database or Docker service was provisioned during implementation.

To return to embedded mode in that PowerShell session:

```powershell
Remove-Item Env:DATABASE_URL
```

These are separate databases. Switching modes does not copy records. `NODE_ENV=production` requires `DATABASE_URL` and refuses an implicit embedded fallback.

## Try the flow

Run these commands in a second terminal while the API is running. Consumer processing is asynchronous, so the helper waits for the expected result rather than assuming immediate delivery.

```powershell
function Wait-ForResult([scriptblock]$Read, [scriptblock]$Ready) {
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try {
      $result = & $Read
      if (& $Ready $result) { return $result }
    } catch {
      if ($_.Exception.Response.StatusCode -ne 404) { throw }
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Timed out waiting for event processing'
}

$tenantId = [guid]::NewGuid().ToString()
$baseUri = "http://127.0.0.1:3000/tenants/$tenantId"

# SIS commits the student and StudentEnrolled message in one transaction.
$student = Invoke-RestMethod -Method Post -Uri "$baseUri/students" -ContentType 'application/json' -Body '{"name":"Asha"}'
$student

# Fees creates the account after receiving the committed event.
Wait-ForResult { Invoke-RestMethod -Uri "$baseUri/fees/$($student.id)" } { param($account) $account.chargedMinor -eq 100000 }
Invoke-RestMethod -Uri "$baseUri/students/$($student.id)/clearance"

# Fees commits the payment, idempotency identity, and PaymentRecorded message together.
$payment = @{ paymentId = [guid]::NewGuid().ToString(); amountMinor = 100000 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$baseUri/fees/$($student.id)/payments" -ContentType 'application/json' -Body $payment
Invoke-RestMethod -Uri "$baseUri/students/$($student.id)/clearance"

# Reporting consumes the event independently.
Wait-ForResult { Invoke-RestMethod -Uri "$baseUri/reports/summary" } { param($report) $report.recordedPayments -eq 1 }

# Retrying the identical payment does not charge or publish again.
Invoke-RestMethod -Method Post -Uri "$baseUri/fees/$($student.id)/payments" -ContentType 'application/json' -Body $payment
```

Stop and restart the API. Queries using the saved tenant/student IDs still return those records. Earlier version 0.1 map-based records cannot be recovered.

## Outbox operations

Stop the API first when using embedded mode. A normal PostgreSQL server allows API and CLI connections together.

```powershell
npm run outbox -- status
npm run outbox -- drain
npm run outbox -- retry EVENT_UUID
```

- `status` lists pending counts, lag, and dead letters.
- `drain` processes one currently due batch; it does not exhaust a large backlog or skip retry delays.
- `retry` requeues a repaired dead letter with the same message ID. Run `drain` or restart the API afterward.
- `OUTBOX_RELAY=off` disables automatic delivery for recovery demonstrations. Producer transactions still save their messages. Remove that environment variable or set another value to resume automatic polling.

Retries use exponential backoff starting at one second, capped at one minute. After ten attempts, the message enters dead-letter storage. Operator repair and replay remain necessary for persistent failures.

## How the implementation works

### Boot, connection, and migrations

`src/shared/database.ts` provides the database globally. It picks a server connection when `DATABASE_URL` is present; otherwise it opens PGlite's disk-backed directory. Both drivers use Drizzle's PostgreSQL query API.

Each module's private `schema.ts` defines its tables and immutable initial migration. Its store applies that migration on initialization. `infrastructure.migrations` records applied module/version pairs. Migration SQL and its ledger row commit together, under an advisory lock. A future schema change must add another version instead of editing an already-applied migration.

`src/app.ts` registers `OutboxModule` and `PostgresOutboxStore`. The store uses the same database and transaction handles as business writes. It owns its own schema migrations. The application starts its relay only after initialization. Shutdown stops delivery before closing the database connection.

Auto-migrations are intentional for this proof. A production rollout needs explicit migration commands, controlled privileges, and reviewed upgrade procedures.

### Commands and queries

Controllers validate input and call their own facades. Facades dispatch typed CQRS commands or queries. Owning handlers enforce rules and access only their own schema.

SIS clearance first verifies its student, then calls exported `FeesFacade.balance()`. It receives a DTO. No SIS code reads Fees tables. Missing fee accounts return 404; immediately after enrolment, that can mean its event has not yet been processed. Clearance remains a snapshot, not a guarantee for a future certificate operation.

### Producer transaction

Enrolment uses one database transaction to insert the student and call `outbox.add(tx, message)`. Payment uses one transaction to lock the account, validate/apply payment, record its tenant-scoped payment ID, and add its event.

If event recording fails, all those writes roll back. If the process stops after commit, the pending event remains stored. `outbox.notify()` runs only after commit and wakes the relay; polling also finds messages after a restart.

Event IDs are UUIDs. Topics are versioned: `sis.student.enrolled.v1` and `fees.payment.recorded.v1`. Ordering keys include tenant and student IDs. The relay is provided by `@nestjs/outbox`, not a custom retry loop.

### Consumers and partial failure

The relay invokes `@OnOutboxMessage()` handlers. Each subscriber has a stable identity: `fees.open-account.v1`, `reporting.enrolments.v1`, or `reporting.collections.v1`.

Each handler opens its own transaction and calls `context.processInTransaction(tx, work)`. Its inbox entry and its owned state commit together. If processing throws, both roll back. The message is retried.

Subscribers run independently. If Reporting succeeds while Fees fails, Reporting remains committed. On retry, its persistent inbox skips it while Fees gets another attempt. After all handlers succeed, the pending message is removed. Outbox tables are a delivery mechanism, not a permanent event archive for rebuilding reports.

### Payment concurrency and idempotency

Amounts are positive safe integers in minor units. `100000` means INR 1,000. A fixed demo charge keeps each account amount within PostgreSQL integer bounds.

`SELECT ... FOR UPDATE` locks the owning account while payment validation and mutation run. The primary key `(tenant_id, payment_id)` protects retry identity in storage. An identical retry returns the current balance. Conflicting details or overpayment return 409. Database constraints also prevent negative or excessive paid balances.

The payment table references only a table in the Fees schema. No module joins or adds foreign keys into another module's schema. Reporting stores its own event-derived records.

### Ownership and public files

| File | Responsibility |
| --- | --- |
| `index.ts` | Public module/facade entrypoint |
| `contracts.ts` | Public commands, queries, DTOs, event types and topics |
| `module.ts` | Nest provider registration and exports |
| `facade.ts` | Public use-case methods |
| `controller.ts` | HTTP input validation and routing |
| `handlers.ts` | Private stores and owning use-case/event handlers |
| `schema.ts` | Private database tables and migrations |

Only `index.ts` and `contracts.ts` can be imported across module boundaries. Tests resolve imports and reject private access. Fees imports SIS contracts only; Reporting imports contracts only; SIS imports Fees' facade. Nest exports separately restrict injection. Reporting is small enough to keep its controller, store, and handlers in one implementation file.

The shared database provider is infrastructure, not permission to read another module's schema. Import checks do not sandbox raw SQL. Tenant predicates are applied in each query, but RLS and authentication are not implemented.

## HTTP contract

Routes and response shapes are unchanged from version 0.1. All IDs must be UUIDs.

| Method | Route under `/tenants/:tenantId` | Body/result |
| --- | --- | --- |
| POST | `/students` | `{ "name": "Asha" }`; student ID and trimmed name |
| GET | `/students/:studentId/clearance` | Outstanding amount and eligibility snapshot |
| GET | `/fees/:studentId` | INR charge, paid amount, outstanding amount |
| POST | `/fees/:studentId/payments` | `{ "paymentId": "UUID", "amountMinor": 100000 }`; current account |
| GET | `/reports/summary` | Students, recorded payments, collections |

Malformed input returns 400, unknown/unprocessed records return 404, and conflicting payments return 409. Unknown body fields are rejected. Queries return DTOs, not mutable database entities.

## Verification and limits

Tests use isolated PGlite databases. Disk-backed restart tests reopen the same temporary directory and verify pending-event recovery. HTTP tests use a real Nest server. Integration tests disable automatic polling and explicitly drain the relay, except the test that verifies automatic delivery.

Coverage includes the original module flow, validation, tenant predicates, duplicate/conflicting payments, overpayment, forbidden imports, producer rollback, consumer rollback, partial fan-out retry, dead-letter replay, concurrent payment attempts, automatic delivery, and disk-backed restart recovery.

The standalone PostgreSQL driver and Compose setup are provided but were not executed here: Docker/PostgreSQL server tooling was unavailable. PGlite serializes database work, so its concurrency tests do not replace testing multiple real PostgreSQL sessions or replicas. Restart tests perform a clean shutdown and reopen; they do not simulate abrupt OS termination or storage loss.

Still omitted: RabbitMQ, separate workers, durable workflows, authentication, entitlements, RLS, and a frontend. This remains a local proof with synthetic data. Tenant IDs in URLs are not authorization. Reporting is not an accounting ledger. The outbox package is version 0.1.2; keep the lockfile and validate upgrades before deployment.

References: [Nest transactional outbox](https://docs.nestjs.com/reliability/outbox), [PGlite API](https://pglite.dev/docs/api).
