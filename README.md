# Invoix Next.js backend

Independent Next.js application using the Node.js runtime and PostgreSQL. Start with `pnpm dev` on port 3001. See the [setup and migration guide](../README.md).

## API routes

Resource paths are available under both `/api` and `/api/v1`. Fields use Rails-style `snake_case`. Lists return arrays, creates return 201, deletes return empty 204, validation returns `{error, errors}` with 422. IDs and monetary amounts retain precision.

| Path after `/api` | Methods |
| --- | --- |
| `auth/login` | POST |
| `auth/logout` | POST, DELETE |
| `auth/signup` | POST |
| `auth/me` | GET |
| `auth/invite?token=...` | GET |
| `auth/forgot-password` | POST |
| `auth/reset-password` | POST |
| `auth/password` | POST recovery request; PATCH/PUT reset |
| `health` | GET |
| `buyers`, `buyers/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `buyers/:id/programmes`, `.../programmes/:programmeId` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `programmes`, `programmes/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `invoices`, `invoices/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `buyers/:id/invoices`, `.../invoices/:invoiceId` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `programmes/:id/invoices` | GET, POST |
| `bids`, `bids/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `invoices/:id/bids`, `.../bids/:bidId` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `buyers/:id/invoices/:invoiceId/bids`, `.../bids/:bidId` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| Any bid member path + `/accept` or `/reject` | PATCH, PUT |
| `financers`, `financers/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `financers/:id/opportunities`, `.../bids`, `.../portfolio` | GET |
| `suppliers`, `suppliers/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |
| `suppliers/:id/invite` | POST to issue/reissue an expiring invitation |
| `users`, `users/:id` | GET/POST collection; GET/PATCH/PUT/DELETE member |

Backend-origin compatibility URLs `/users/sign_in`, `/users/sign_out`, `/users/me`, `/users/password`, `POST /users`, and `/up` map to the new handlers. Legacy JWTs are not accepted; sign in for a new session.

## Payloads and authentication

Writes accept a resource wrapper (`{buyer:{...}}`, `{invoice:{...}}`, etc.) or a flat object. Buyers accept both `users` and `users_attributes` for atomic updates. Supplier `contact_email` maps to profile and account email.

```json
{"invoice":{"programme_id":"1","supplier_id":"2","invoice_number":"INV-001","currency":"GHS","amount":"1250.50","status":"draft","issue_date":"2026-11-10","due_date":"2030-12-31","description":"Delivered goods","payment_terms":"Net 30","financing_eligible":true}}
```

```json
{"bid":{"amount":"1200.00","currency":"GHS","discount_type":"flat","discount_rate":"2.5","other_fees":"5.00","expiry_date":"2030-12-01"}}
```

Buyer signup requires `email`, `password`, `role: buyer_admin`, company `name`, `registration_number`, and two-letter `country`. Invitation acceptance instead requires `role: supplier_user` and `invite_token`. New passwords need 10 characters and at most 72 UTF-8 bytes. Existing Devise passwords remain valid at login. Operations accounts are provisioned through the seed CLI.

Authentication uses a random token in the HttpOnly `invoix_token` cookie, or `Authorization: Bearer <token>`. Only the token hash is stored. Current database identity and permissions are checked on every request. `APP_URL` defines the allowed browser origin; forwarding headers are not trusted for origin or throttling identity.

## Authorization and financial rules

Operations administers all resources. Buyer admins manage their own buyer/programmes/invoices and may assign only buyer/supplier roles within that buyer. Supplier accounts read their own invoices and associated bids. Financers see tendered invoices and invoices on which they bid, and only their own bids and portfolio. User profile access is self or operations; account CRUD is operations-only.

Invoice transitions follow `draft → approved → tender → funded → repaid`; approved can return to draft. New invoices may start in draft, approved, or tender. Funding occurs only after independently verified disbursement evidence. Terms become immutable after bidding begins; funded/repaid details cannot change. Monetary inputs must be positive and use at most two decimal places.

Only financers place bids on tendered invoices and edit/withdraw their own pending bids. Buyer admins for that invoice or operations can accept/reject. Acceptance locks the invoice and the winning offer, closes other pending bids, and leaves the invoice awaiting verified disbursement. It does not mark the invoice funded. A partial unique index independently prevents multiple accepted bids. Deletes with financial dependencies return 409.

## Live connection check

With both apps running against a disposable local database and a disposable operator provisioned, run `pnpm test:http` with `SMOKE_FRONTEND_URL`, `SMOKE_EMAIL`, and `SMOKE_PASSWORD`. This check writes sample financial records; it must not target a live deployment. It exercises browser-facing API forwarding, authentication, SSR pages, funding, and empty delete responses.

## Layout

- `src/app/api/[...path]/route.ts`: native route entrypoint with awaited parameters.
- `src/server/http.ts`: request handling, origin checks, authentication, errors.
- `src/server/auth*.ts`: sessions, credential compatibility, invitations, recovery.
- `src/server/resources.ts`: authorized resource operations for both API prefixes.
- `src/server/db.ts`: parameterized PostgreSQL queries and transactions.
- `db/migrations/`: SQL for new and existing databases.
- `scripts/`: migration, operator provisioning, maintenance.
- `tests/`: isolated PostgreSQL integration tests.

For remote PostgreSQL, use certificate verification (`sslmode=verify-full` and the proper CA certificate in `DATABASE_URL`). Keep environment files and database dumps out of source control.

## Financial foundation increment

See [the development baseline](../docs/DEVELOPMENT.md) for requirement traceability, open decisions and outstanding controls. Production financial writes, including offer acceptance, are blocked until the required onboarding, MFA, tenancy and allocation controls have been delivered. The manual evidence workflow operates only in development/testing; it does not send payments or assert a bank connection.

All endpoints below use normal authenticated sessions and the existing invoice access boundaries. Mutation requests require an `Idempotency-Key` header (8–100 characters) or `idempotency_key` in the JSON body. Identical retries return the original result; changing the payload while reusing a key returns 409.

| Path after `/api` | Method and operation |
| --- | --- |
| `invoices/:id/financials` | GET: agreements, evidence, position and financial audit history |
| `invoices/:id/agreements` | POST: operations proposes explicit contractual amounts, currency, maturity and executed-document reference |
| `agreements/:id/sign` | POST: another operator verifies executed agreement evidence |
| `agreements/:id/reject` | POST: independent operator rejects incorrect evidence; a fresh proposal may then be recorded |
| `invoices/:id/fundings` | POST: selected financier or operations records disbursement evidence |
| `fundings/:id/confirm`, `fundings/:id/reject` | POST: a different operator independently reviews payment evidence |
| `invoices/:id/repayments` | POST: buyer or operations records a receipt, with explicit amount and currency |
| `repayments/:id/confirm`, `repayments/:id/reject` | POST: independent operations verification |
| `invoices/:id/repayments/:receiptId/reverse` | POST: operations proposes a full reversal of a confirmed receipt; another operator must confirm it |

The contractual repayment amount is entered explicitly; it is not inferred from invoice face value. Pending receipts do not reduce balances. Confirmed full settlement moves the invoice to repaid; confirmed reversal reopens the position. Currency must match throughout. Supported portal currencies are GHS, USD, EUR, NGN and KES (two decimal places), with no implicit conversion.

Journals track administered buyer obligations and external funder entitlements, not the platform's bank balance or earned revenue. They must balance at transaction commit. Audit events, completed records, journals and lines cannot be edited/deleted through normal SQL paths. The financial position is one SQL projection of confirmed receipts less confirmed reversals; every participant reads that same position.

Migration `002_financial_controls.sql` adds the financial records and flags legacy funded/repaid invoices or accepted offers for reconciliation. It preserves their historical statuses and does not fabricate supporting agreements or transactions. Flagged legacy records cannot be processed until an evidence-based reconciliation workflow is implemented. Previously applied baseline migrations are not automatically undone.

`src/server/money.ts` provides exact integer-minor-unit calculations and annual-simple, flat and fixed-fee discount formulas. The calculation module is tested independently; production quote ingestion, approved rate snapshots and marketplace policy integration remain outstanding.

## Expanded field APIs

See [the field inventory](../docs/FIELD_COVERAGE.md) for all input requirements and read-only authority fields. `GET /api/field-definitions[/entity]` drives the forms. Operations can capture supporting drafts with `/api/controls/:entity[/id]` (GET/POST collection, GET/PATCH member); these routes do not execute approval or financial controls. `GET /api/lookups/:entity` returns safe relation labels with role restrictions. `POST /api/invoices/:id/bid-quote` previews server-calculated proceeds without creating a bid. All support `/api/v1`.

## Portal services

`/api/portal/session` returns the authenticated role/organisation; `/api/portal/bootstrap` returns only scoped real records for the portal adapter. New portal routes cover invoice submission and supplier decisions, invited tenders, private bid drafts/withdrawal, programme participant links, supplier invitations, reviewed onboarding decisions, notification read state, profile/preferences, exception notes and draft configuration. They are available under `/api/v1` as well. Existing resource/financial endpoints remain active.

`/api/portal-auth` handles registration, email send/verify, onboarding, contact messages and authenticator setup/enrol/verify. `/api/portal/documents` accepts multipart PDF/PNG/JPEG uploads up to 10 MB; `/api/portal/documents/:id` serves only authorised attachment downloads. Files are kept out of public assets. Configure `DOCUMENT_STORAGE_PATH` for persistent private production storage and `MFA_SECRET_KEY` as a private 32-byte hexadecimal key before authenticator setup. Preserve this key with your server secrets; changing it makes enrolled secrets unreadable.

Configuration endpoints retain drafts. They cannot bypass the financial production-release guard or silently grant permissions. Mail delivery requires SMTP in production; local development provides private preview links. Legal document approval, malware scanning, notification delivery workers and production integrations remain separate prerequisites.
