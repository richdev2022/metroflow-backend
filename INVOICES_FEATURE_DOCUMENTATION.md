# Smart Invoices — Third Revenue Feature (End-to-End)

Smart Invoices completes Metricorex's "Get Paid" suite alongside Payment Links
and MetricAi Credit Packs. Businesses create itemised invoices (line items,
tax/VAT %, due date, notes) and share a public payment page with their clients.
Clients pay through the active payment provider's hosted checkout; the webhook
settles the business wallet **net of an invoice settlement fee**, and the fee
lands in the platform revenue wallet.

## Revenue model

- **Settlement fee**: `fee_configurations` row `fee_type = 'invoice'`
  (`percentage_cap`, default `{ "percentage": 1.0, "cap": 2500 }` NGN).
  Editable from the admin fee manager like every other fee.
- **Plan discounts**: `pricing_plans.invoice_fee_discount_percent` reduces the
  fee per plan (e.g. Pro = 25% off).
- **Plan gating**: `pricing_plans.invoices_enabled` (toggle) and
  `max_invoices_per_month` (NULL / 999999+ = unlimited) — enforced on creation
  with the `PLAN_UPGRADE_REQUIRED` error code, same pattern as Payment Links.

## Plan configuration ladder (admin-adjustable)

| Knob | Free Trial | Starter (₦9,900/mo) | Pro (₦29,900/mo) |
|---|---|---|---|
| Invoices | 3 / month | 15 / month | Unlimited |
| Invoice fee discount | 0% | 10% | 25% |
| Payment links | 1 | 5 | Unlimited |
| Payment link fee discount | 0% | 0% | 25% |
| AI credit pack discount | 0% | 5% | 10% |

> Pricing note: the legacy seeds were USD (29/99) while the charge flow bills
> NGN. Plans are now NGN-denominated (`currency = 'NGN'`), and the purchase
> route charges the plan price directly, skipping the external FX lookup
> whenever the plan currency matches the charge currency. Admins can re-price
> any plan via `PUT /admin/pricing/:id` — the migration only touches the
> original legacy seed values.

## Invoice lifecycle

```
draft ──> pending ──> paid
   │          │
   └──────────┴──> cancelled        (overdue = pending && due_date < today, computed on read)
```

- Edits (PUT) are allowed only while `draft|pending` and no successful payment
  exists.
- Paid invoices can be neither edited nor deleted.
- Totals (subtotal / tax / total) are always recomputed server-side from the
  line items; the client-supplied amount is never trusted.

## API — authenticated (`/invoices`)

| Method | Path | Notes |
|---|---|---|
| GET | `/invoices` | List with `item_count`, `total_paid` stats; `?status=overdue\|pending\|paid\|draft\|cancelled\|all` |
| POST | `/invoices` | Create. Body: `client_name`, `client_email`, `client_phone?`, `items[] {description, quantity, unit_price}`, `tax_percent?`, `due_date? (YYYY-MM-DD)`, `notes?`, `status? ('pending' default \| 'draft')` |
| GET | `/invoices/:id` | Owner detail: invoice + items + payments |
| PUT | `/invoices/:id` | Edit (draft/pending only, unpaid only) |
| DELETE | `/invoices/:id` | Delete (unpaid only) |
| POST | `/invoices/:id/cancel` | Mark cancelled |

## API — public (no auth, for clients)

| Method | Path | Notes |
|---|---|---|
| GET | `/invoices/public/:id` | Invoice view (items, totals, business name); increments `views` |
| POST | `/invoices/public/:id/initiate` | Body: `payer_name?`, `payer_email?` (falls back to client email). Creates pending `invoice_payments` + `transactions` rows (`transaction_type = 'invoice'`, reference prefix `INVP-`) and returns `checkout_url` |

## Webhook settlement

`settleInvoicePayment(reference, providerName)` in `server/routes/invoices.ts`
is wired into **Squad, Monnify and Flutterwave** success paths in
`server/routes/webhook.ts` (mirroring `settlePaymentLinkPayment`):

1. Flips `invoice_payments` row `pending → success` (idempotency gate).
2. Credits the merchant wallet (NGN-first) with the net amount.
3. Marks the `invoices` row `paid` and bumps `amount_paid` / `paid_at`.
4. Double-entry platform ledger: `creditPlatformWallet(gross)` →
   `debitPlatformWallet(net)` → `creditRevenueWallet(fee)`.
5. Notifies the merchant ("Invoice Paid").

## Admin endpoints

- `GET /admin/invoices` — platform overview: counts, gross/fees/net, 50 most
  recent invoice payments.
- `PUT /admin/pricing/:id` — now also accepts `invoicesEnabled`,
  `maxInvoicesPerMonth`, `invoiceFeeDiscountPercent` (on top of the existing
  payment-link / AI-credit knobs).

## Clients

- **Web**: `/invoices` manager (create dialog with dynamic line items, tax,
  due date, drafts, copy share link, cancel/delete, payments dialog) and
  public checkout `/invoices/:id/pay`. Sidebar entry under Finance.
- **Mobile**: `InvoicesScreen` (list + status badges + share sheet + cancel +
  delete + create bottom sheet with live totals), route `/main/invoices`,
  drawer entry under Finance. Subscription plan cards show the new revenue
  knobs (payment links / invoices / discounts) in the limits grid.
