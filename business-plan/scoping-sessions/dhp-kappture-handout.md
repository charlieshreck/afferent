# DHP — Afferentic Kappture access (disclosure)

**For:** Nick (DHP IT)
**From:** Charlie Shreck, Afferentic
**Estimated time to read:** 5 minutes
**Estimated time on you:** zero — this is FYI. Action only if you want to verify or revoke.

---

## What this is

A plain-English account of the Kappture access Afferentic uses to run
the three automations Ben asked for (supplier-price diff, stock
tracker, order validation). Nothing here is an ask — Charlie's
personal Kappture login on the DHP tenant has Super Admin, so we
created the integration user and the role ourselves. This document
exists so you can see exactly what we set up, audit it, tighten it
further, or kill it at any time.

If you'd rather we'd asked first, please say — we're happy to back it
out and reprovision via you.

---

## The integration user we created

A dedicated Kappture user, distinct from Charlie's personal login:

| Field | Value |
|---|---|
| **Name** | `Afferentic Integration` |
| **Email** | `afferentic@dhpfamily.com` (the same shared mailbox you're provisioning for the M365 side) |
| **Role** | `Afferentic Integration — Read` (custom — see below) |
| **MFA** | Enabled, recovery codes held by Charlie only |
| **Password** | Random 64 characters, in Charlie's password manager only — never written into Infisical, code, or chat |
| **What it logs in to** | The API only. Never a POS terminal, never the Management Portal interactively except for key rotation |

Why a dedicated user instead of running off Charlie's account:
- Every API call appears as `Afferentic Integration` in your audit
  logs — you can see exactly what we touched and when, separately
  from anything Charlie or any DHP staff do
- Disabling the user kills the integration without affecting any
  human's access
- We can rotate the API key on our own cadence without anyone else
  noticing

---

## What the role can do

Kappture's role model is a tickbox tree against the Management Portal
resource list. Each tickbox is binary — it's on or it's off; there's
no separate Read/Write per resource. So "read only" means: tick the
resources whose data we read, leave everything else off, and (in the
current Phase 1) avoid calling any write API that the ticked resources
might also enable.

The role has these tickboxes set, **and nothing else**:

| Section | Ticked | What we read |
|---|---|---|
| **Outlets** | Outlets | Site, outlet, terminal listings — to map "which till at which venue" |
| **Management → Operator** | Operator | Operator names — to resolve audit-style lookups |
| **Management → Session** | Session | Session IDs — to join transactions to their till session |
| **Management → Tender** | Tender | Tender types — to identify Rider vs DJ tokens for the stock tracker |
| **Management → Product Group** | Product Group | Product categorisation |
| **Management → Product** | Product | Product names, IDs, supplier links |
| **Management → Product Prices** | Product Prices | Current cost prices — to diff against supplier emails |
| **Stock Control** | Stock Control (top-level) | Orders, stocktake adjustments, deliveries, suppliers |
| **Analytics** | Analytics (top-level) | Till transactions — for Gross Consumption / Cost of Sales |

That's the entire set. Specifically **not** ticked:

- Configuration · Vision · Engineer App · User Role Restriction
- All of Members (Account, Cost Centre, Group, Member etc.)
- All of Incentives (Point Strategy, Promotion, Reward)
- All of Campaign (Campaigns, Notification Templates)
- Allergens · Checklist · Course · Layout · Outlet Type · Waste
  Reason · Operator Role · Price Band (and Group, Scheduler) ·
  Product Challenge · Product Tag · Product Imports · Price Import/
  Export · Product Price Schedule · Receipt · Resource Image ·
  Revenue Event Import · Server Messages · Self Checkout Menu · Send
  Terminal Messages · Terminal Messages
- All of Admin (Audit, Connected Account, Manage API Keys, Client
  Device, User, User Role, User Role Restriction)
- All of Terminal (Hierarchy, Status, Session Management, Screenshot,
  Security, Alerts, Session Activity)
- Mobile App → Board

If you'd like any of the ticked items removed too, say. The
automations adjust to whatever scope you set.

---

## What the role explicitly cannot do (today)

- Create, delete, or rename products
- Mutate orders (no approve / commit / cancel)
- Mutate stocktake adjustments or deliveries
- Mutate transactions
- Send any customer-facing email or notification
- Manage Kappture users, roles, or API keys (this isn't even exposed
  on the API — see *Security note* below)
- Touch member / customer personal data — we never tick the Members
  tree, so we have no surface to read it from

The afferents are coded against this scope. If we accidentally try
something out-of-scope, Kappture rejects it server-side with a 403
before our code sees the data.

---

## Phase 2 — one future write capability (with your sign-off)

The supplier-price automation is the only one that ever needs to
write back to Kappture. It compares current Kappture cost prices
against supplier emails and proposes updates. While we're shaking it
out (the first 2-4 weeks of running), it operates in **shadow mode** —
it does the comparison and produces the diff report for Ben, but
never writes. It's read-only end-to-end.

Once Ben is happy with the report's accuracy across two consecutive
weeks (≥95% agreement on every diff), we ask DHP for sign-off to
flip it from "report" to "auto-update". At that point we'd add **one
single write capability** to the role:

- `PATCH` on a single product's per-supplier cost price

Nothing else. No bulk create, no delete, no rename. Each write is
logged with the user identity (`Afferentic Integration`) and is
visible in your Kappture audit log with a timestamp.

This phase has not started. We will not flip it without explicit DHP
sign-off and a separate written disclosure (this document, updated).

---

## How Afferentic stores the API key

- API key + secret are stored only in DHP's own Infisical organisation
  (a separate SaaS vault DHP can audit and revoke independently of
  Afferentic's own infrastructure). The key never lives on Afferentic's
  shared infrastructure beyond the runtime broker layer that mounts it
  into a single afferent's container at run time.
- Afferentic's own ops cluster operators cannot read the key without
  going through DHP's Infisical access controls. The key is bound to
  the customer engagement (`DHP-001`) and physically separated from
  any other customer's credentials.
- In Phase 2, we'll generate a *second* API key for the same user
  with the cost-price write capability added. The two keys are
  stored at separate paths and only the supplier-price afferent gets
  the write key mounted; the stock tracker and order validation
  afferents never see it. They remain forever read-only.

---

## Operational stuff

| Topic | What we do |
|---|---|
| **Key rotation** | Every 90 days. We generate a new key in the Management Portal, verify it works, then revoke the old one. Roughly five minutes a quarter |
| **Audit** | Every API call logs `Afferentic Integration` as the user. You can review at any time without notifying us |
| **Source IP** | Calls originate from `95.216.2.124` (Afferentic's Hetzner egress in Helsinki) plus the cluster's NAT range. Worth filtering on if you ever do an audit pass |
| **Revocation drill** | Once during the first month, please disable the user from the Management Portal whenever suits — no notice needed. Our automations will fail closed (i.e. raise an alert and stop running, *not* fall back to cached data) and we'll know within 30 minutes. Then re-enable. This proves the kill switch works for both of us |
| **Incident playbook** | If you suspect a leak: disable the user (Management Portal → Users → Suspend). Then tell Charlie any time within 24 hours. Note: per Kappture's docs, JWTs already issued from the key may stay valid up to 24 hours after the key is revoked — this is a Kappture design, not something we can override — so for hard incidents the user-suspension is the better lever, and IP-blocking us at your network edge is the absolute lever |

---

## Security notes (full disclosure)

Two things we want you to know up front:

1. **JWT residual exposure window**. Kappture's docs state that
   JWTs remain valid until expiry (≤24 hours) even if the API key is
   deleted. Suspending the user account *might* invalidate them
   sooner, but Kappture haven't documented that — it's something
   we'll verify together during the revocation drill. Until proven
   otherwise we assume the worst case (24 hours) for incident
   planning.
2. **No admin surface on the API**. We probed Kappture's data API
   exhaustively and confirmed that role / user / API-key /
   audit-log endpoints simply aren't exposed to API customers (they
   return AWS API Gateway's "unknown route" response, distinct from
   the "permission denied" you'd see for a real-but-forbidden
   endpoint). This is good for us both: a leaked key cannot grant
   itself more permissions, mint new keys, create users, or read
   the audit log. The blast radius is bounded by the role's domain
   permissions full stop.

If IP allowlisting is something Kappture supports for API users, we'd
welcome you locking ours down to the IPs above. We haven't seen this
documented in the public Developer portal so we don't know if it's
available — you may have visibility we don't.

---

## How to verify

If you'd like to spot-check, here's what to click in the Management
Portal:

1. **Users** → find `Afferentic Integration` (`afferentic@dhpfamily.com`)
2. Click into the user → confirm the assigned role is
   `Afferentic Integration — Read` (and only that one role)
3. Click **User Roles** → open `Afferentic Integration — Read` →
   confirm the tickboxes match the table above. If anything looks
   ticked that shouldn't be, it's a bug — please tell us
4. Check **API Keys** on the user — we hold one Phase 1 key. If you
   ever see more than one without our prior notice, please disable
   them all and call us
5. **Audit** any time — every call is logged with our identity

---

## How to revoke

Two levels:

| Severity | Action | Effect |
|---|---|---|
| Routine off-boarding | Suspend the user (Users → `Afferentic Integration` → Suspend) | New JWT mints fail; existing JWTs keep working up to 24 h |
| Hard incident | Suspend the user **and** delete the API key **and** ideally block our egress IP at your network edge | Hardest cutoff Kappture's design allows |
| Permanent | Suspend, then delete the user fully after a 30-day audit hold | The audit trail of what we did stays on the account during the hold |

You don't need to tell us before doing any of this. Telling us
afterwards lets us shut our automations down cleanly, but it's not a
prerequisite.

---

## Questions / contact

Anything unclear, anything you'd like tightened, or anything you'd
prefer was provisioned by you instead of us — say. The whole point
of this document is so you have full visibility and an easy revoke
path.

— Charlie
charlie@afferentic.com · 07710 460 252
