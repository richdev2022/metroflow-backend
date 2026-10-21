# Personal Features (Dormant) — Bills Hub & Savings Vaults

These two features are **Personal Metricorex** features, not business features.
They were briefly implemented inside the business app and have now been moved
here, out of the running product, until the Personal app commences.

## Contents

| File | Purpose |
|------|---------|
| `bills.ts` | Express router — airtime / data / TV / electricity / betting top-ups from any wallet, PIN-verified, flat ₦50 convenience fee (plan-discounted), pluggable fulfilment via `bills-provider.ts` (simulator + auto-refund until a live VTU provider is connected). |
| `savings.ts` | Express router — goal-based savings vaults with auto-save (daily / weekly / monthly) and a 2% early-withdrawal break fee (plan-discounted). Exports `processDueAutoSaves` for the 5-minute cron. |
| `bills-provider.ts` | Pluggable VTU fulfilment adapter (`BILLS_PROVIDER_URL` + optional `BILLS_PROVIDER_API_KEY`; built-in simulator when unconfigured). |
| `schema.ts` | `ensurePersonalSchema()` — idempotent DDL + fee seeds for `bill_payments`, `savings_vaults`, `savings_transactions` and the personal plan knobs. |

None of this is mounted, migrated or scheduled by the business backend right now.

## Reactivating when the Personal app ships

1. **Migrations** — call `ensurePersonalSchema()` from
   `runPostInitializeMigrations()` in `server/migrations.ts`.
2. **Routes** — mount the routers in `server/index.ts`:
   ```ts
   import billsRouter from "./features/personal/bills";
   import savingsRouter from "./features/personal/savings";
   mainRouter.use("/bills", billsRouter);
   mainRouter.use("/savings", savingsRouter);
   ```
3. **Cron** — re-add the 5-minute auto-save cron that imports
   `processDueAutoSaves` from `./features/personal/savings`.
4. **Admin** — surface the personal plan knobs in the admin pricing UI:
   `bills_enabled`, `max_bills_per_day`, `bill_fee_discount_percent`,
   `savings_enabled`, `max_savings_vaults`, `savings_break_fee_discount_percent`.
5. **Swagger** — the files already carry `@openapi` annotations; they will be
   picked up by `npm run generate-swagger` once the routers are mounted and the
   files are referenced from the build again (the generator scans
   `./server/routes/*.ts`, so either re-export the routers from a routes file
   or extend the globs in `scripts/generate-swagger.ts`).

> Note: the `pricing_plans` knob columns already exist on production databases
> from the brief business-app period. They are harmless there and will simply
> be reused by the Personal app.
