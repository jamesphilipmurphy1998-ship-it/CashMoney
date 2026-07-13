# Sharesies unofficial API — reverse-engineered reference

No public docs exist for this. This file records everything found by capturing
real traffic from sharesies.nz's own web app on 2026-07-06, so a future
breakage (Sharesies changes a field/endpoint) can be fixed by comparing fresh
traffic against this doc instead of re-deriving everything from scratch.

Implementation: [sharesies.js](sharesies.js). If a call here starts failing,
the fastest fix is: open sharesies.nz in a browser, log in, DevTools → Network
→ Fetch/XHR, find the equivalent request, and diff its shape against what's
documented below.

## Three hosts, three tokens

Login returns tokens for two different backend services. A third host serves
public instrument data. All three matter for a full holdings import:

| Host | Used for | Auth |
|---|---|---|
| `app.sharesies.nz` | login, 2FA | — |
| `data.sharesies.nz` | ticker/exchange lookup by fund id | `Authorization: Bearer <distill_token>` |
| `portfolio.sharesies.nz` | per-holding cost basis / value | `Authorization: Bearer <rakaia_token>` |

## Step 1 — login

```
POST https://app.sharesies.nz/api/identity/login
Content-Type: application/json

{ "email": "...", "password": "...", "remember": true }
```

Two possible responses:

**No 2FA on the account** — full session immediately:
```json
{ "distill_token": "<jwt>", "rakaia_token": "<jwt>", "user": { "portfolio_id": "<uuid>", ... }, "portfolio": [...] }
```

**2FA required:**
```json
{ "invalid_mfa_token": false, "type": "identity_mfa_required" }
```
Response also sets session cookies (`remember=...; session=...`) that must be
carried into step 2 — capture them from `Set-Cookie` and send back as `Cookie`.

## Step 2 — complete 2FA

Same endpoint, same body, plus the code and the cookies from step 1:

```
POST https://app.sharesies.nz/api/identity/login
Cookie: <cookies captured from step 1>
Content-Type: application/json

{ "email": "...", "password": "...", "remember": true, "mfa_token": "123456" }
```

**Field name gotcha**: the code field is `mfa_token`, NOT `mfa_code` or `otp`.
Sending the wrong field name gives `{"errors":{"mfa_code":["Rogue field"]},"type":"validation_error"}`
— a 400 with a "Rogue field" message on some field means "this field doesn't
exist in the schema," not "wrong value." The tell for the correct name was
the login response's `invalid_mfa_token` key in step 1 — it names the field
the second call should use.

Success response is the same full shape as the no-2FA case above:
`distill_token`, `rakaia_token`, `user.portfolio_id`, `portfolio`.

## Field names are snake_case, not the old community libraries' PascalCase

Two community projects exist (jontymorris/Sharesies-API in Python,
deividfortuna/sharesies in Go) and both assume PascalCase fields
(`DistillToken`, `FundID`, `Shares`, `Contribution`). **That's stale** — the
real API uses snake_case (`distill_token`, `fund_id`, `shares`). Those
libraries' `Portfolio` struct also claims `Contribution`/`Value` fields that
no longer exist in the login response's `portfolio` array — see below.

## The `portfolio` array in the login/2FA response is minimal

```json
"portfolio": [
  { "fund_id": "<uuid>", "holding_type": "nz-company", "shares": "70.00000000", "shares_active": "70.00000000" }
]
```

Only fund id + share count. No cost basis, no current value. This is why a
separate call to `portfolio.sharesies.nz` (below) is needed — don't waste time
looking for cost basis fields here again.

## Resolving fund_id -> ticker symbol

```
GET https://data.sharesies.nz/api/v1/instruments/<fund_id>
Authorization: Bearer <distill_token>
```

Returns a large object; the fields we use:
```json
{ "symbol": "HNST", "exchange": "NASDAQ", "name": "Honest Company Inc", "currency": "USD" }
```

`exchange` seen values so far: `NASDAQ`, presumably `NYSE`, `NZX`, `ASX` for
local listings. Mapped to a Yahoo-compatible ticker suffix in `sharesies.js`'s
`EXCHANGE_SUFFIX` (NZX -> `.NZ`, ASX -> `.AX`, US exchanges -> no suffix). If
Sharesies adds a market we don't hold yet, extend that map when it's hit.

There's also a batch endpoint `POST https://data.sharesies.nz/api/v1/instruments`
with a JSON body — untested field name that works; `{"ids":[...]}` gets
rejected with `{"errors":{"Query":["The Query field is required."]}}`. Not
worth chasing since the single-id GET works fine; only revisit if per-holding
GETs become a rate-limit problem.

## Per-holding cost basis / value

This is the piece that took the longest to find — it's on a **third host**,
not `app.` or `data.`:

```
GET https://portfolio.sharesies.nz/api/v1/portfolios/<portfolio_id>/instruments
Authorization: Bearer <rakaia_token>
```

`<portfolio_id>` comes from the login response's `user.portfolio_id`.

Using `distill_token` here gives `403 {"detail":"Could not validate credentials"}`
— this host wants `rakaia_token` specifically, not the same token as
`app.sharesies.nz`/`data.sharesies.nz`.

Response shape:
```json
{
  "instrument_returns": {
    "<fund_id>": {
      "instrument_uuid": "<fund_id>",
      "shares_owned": 66.00585312,
      "investment_value": 34179.15,
      "cost_basis": 7529.67,
      "cost_basis_max": 7529.67,
      "total_return": 26649.19,
      "simple_return": 353.92,
      ...
    }
  }
}
```

`cost_basis / shares_owned` = average cost per share, which is what this
app's `position.cost` field expects (see `openPosition` in `app.js`).

There's a sibling endpoint at the portfolio level (no instrument breakdown):
```
GET https://portfolio.sharesies.nz/api/v1/portfolios/<portfolio_id>
```
Same auth. Returns aggregate `portfolio_value`, `cost_basis`, `total_return`,
`portfolio_history` (a whole timeseries) etc. — not currently used, but useful
if we ever want an "as reported by Sharesies" total to sanity-check imports
against.

There's also `.../compact-history?from_date=YYYY-MM-DD` on the same host —
looked like transaction-level history in passing; not explored further since
`instruments` already had what we needed.

## If it breaks again

1. Check `server/data/server.log` / add a temporary `console.log(JSON.stringify(body))`
   in the relevant `sharesies.js` function first — Sharesies' error responses
   are usually descriptive (e.g. "Rogue field", "Could not validate
   credentials") and often enough to fix the request without a browser at all.
2. If that's not enough, capture real traffic: sharesies.nz in a browser →
   DevTools → Network → Fetch/XHR → find the equivalent request → compare its
   Request URL / Headers / Response against this doc.
3. Update this file when you find something new — that's the whole point.
