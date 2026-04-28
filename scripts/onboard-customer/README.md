# onboard-customer

Driver script for adding a new Afferentic customer with proper segregation
from day one. Use it once per customer.

## What "proper segregation" means here

Per ADR-0023 + ADR-0024 and the in-progress addendum to ADR-0011:

- **Customer secrets in their own Infisical organisation** (not just project)
  — gives each customer a fresh free-tier (3 projects × 5 identities) and
  removes any shared-tenant blast radius. Cost: one extra Infisical signup
  per customer.
- **Customer code in its own K8s namespace** `customer-<slug>` in the
  Afferentic prod cluster — enforces secret + workload boundary at runtime.
- **Customer Microsoft 365 access scoped to a per-customer alias**
  `<slug>@afferentic.com` for org registrations + customer-team emails.

## What this script does end-to-end

```
┌───────────────────────────────────┬───────────────────────────────────┐
│ STEP                              │ AUTOMATION STATUS                 │
├───────────────────────────────────┼───────────────────────────────────┤
│ 1. M365 alias <slug>@afferentic   │ MANUAL today (admin portal click) │
│                                   │ — until User.ReadWrite.All scope  │
│                                   │   is added to Afferentic app      │
├───────────────────────────────────┼───────────────────────────────────┤
│ 2. Infisical org signup under     │ MANUAL — Infisical Cloud has no   │
│    that alias                     │ org-creation API on free tier.    │
│                                   │ Script auto-extracts verification │
│                                   │ link from charlie's inbox.        │
├───────────────────────────────────┼───────────────────────────────────┤
│ 3. Universal Auth identity        │ MANUAL one-time creation in UI    │
│    creation in new org            │ (paste back to script).           │
├───────────────────────────────────┼───────────────────────────────────┤
│ 4. K8s manifests for namespace,   │ AUTO                              │
│    InfisicalSecret CRDs,          │                                   │
│    bootstrap auth Secret,         │                                   │
│    NetworkPolicy, ResourceQuota   │                                   │
├───────────────────────────────────┼───────────────────────────────────┤
│ 5. Stash bootstrap creds in       │ AUTO when AFFERENTIC_INFISICAL_*  │
│    Afferentic main Infisical for  │ env vars are set; otherwise       │
│    cluster-rebuild resilience     │ manual copy.                      │
└───────────────────────────────────┴───────────────────────────────────┘
```

Two clicks of human time per customer, ~5 minutes wall-clock total.

## Usage

```bash
python3 onboard.py --slug dhp --display-name "DHP Family"
```

Slug rules: lowercase letters/digits/hyphens only. Becomes:
- M365 alias: `<slug>@afferentic.com`
- K8s namespace: `customer-<slug>`
- Manifest dir: `afferentic_prod/kubernetes/applications/customer-<slug>-bootstrap/`

## What the generated manifests do

```
customer-<slug>-bootstrap/
├── 00-namespace.yaml          # the namespace itself, with customer label
├── 10-infisical-auth.yaml     # bootstrap k8s Secret (clientId/clientSecret
│                              #   for the customer's Infisical UA identity)
├── 20-secrets.yaml            # InfisicalSecret CRDs for /kappture, /m365
│                              #   (extend as needed when more paths exist)
├── 30-networkpolicy.yaml      # default-deny + scoped egress
└── 40-resourcequota.yaml      # 2 CPU / 4Gi RAM / 5 PVCs
```

After commit + ArgoCD sync, the customer namespace is alive and the
InfisicalSecret operator pulls real K8s Secrets into it from the customer's
own Infisical org.

## What this script DOES NOT do (yet)

- Migrate existing customer afferents from `ai-platform` namespace into
  the new `customer-<slug>` namespace. That's a per-customer follow-up
  commit (move the manifests, update env-var refs to point at the new
  Secrets, retest).
- Create the M365 alias automatically. Blocked on `User.ReadWrite.All`
  scope grant to the Afferentic Platform app.
- Create the Infisical org. Blocked on Infisical Cloud not exposing an
  org-creation API on the free tier.

The first one we can absolutely automate next; the other two are
externally constrained.

## Permission/cost reference

- Free Infisical org per customer = $0/mo (3 projects, 5 identities each)
- Adding `User.ReadWrite.All` to Afferentic Platform app = $0, one-click
- M365 alias (proxyAddress) = $0 — uses primary mailbox's mail flow

When you outgrow the free tier on a per-customer basis, that customer is
big enough to pay you for it. Forcing function aligned.

## Related docs

- `~/afferentic/docs/decisions/0011-infisical-three-project-segregation.md`
  (and the customer-segregation addendum we'll write next)
- `~/afferentic/docs/decisions/0023-dhp-afferents-test-method.md`
- `~/afferentic/docs/decisions/0024-customer-sharepoint-backend.md`
- `~/afferent/business-plan/scoping-sessions/dhp-nick-meeting-brief.md`
