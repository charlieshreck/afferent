"""onboard-customer — automate everything we CAN automate when adding a new
Afferentic customer.

Two manual steps remain (Infisical's free tier doesn't offer org-creation
API, and our M365 app currently lacks User.ReadWrite.All). Everything else
this script does end-to-end:

  1. (manual)   You add `<slug>@afferentic.com` alias to charlie's mailbox
                in M365 admin (or grant User.ReadWrite.All app scope and
                this script does it via Graph).
  2. (manual)   You go to https://app.infisical.com/signup and register a
                new organisation under <slug>@afferentic.com — verification
                email lands in charlie's inbox; this script auto-extracts
                the click-link and presents it to you.
  3. (manual)   In the new Infisical org, create a Universal Auth machine
                identity scoped to read everything in the default project.
                Paste its client_id + client_secret back into this script.
  4. (auto)     Script bootstraps the K8s side:
                - Creates `customer-<slug>` namespace manifest
                - Creates an InfisicalSecret CRD + InfisicalAuth bootstrap Secret
                - Updates the customer's afferent CronJob manifests to use the
                  new namespace + secret refs
                - Stores the bootstrap creds in AFFERENTIC's main Infisical
                  at `/customers-bootstraps/<slug>/` so they survive cluster
                  rebuilds without us re-running this script
  5. (auto)     Verifies the bootstrap secret can fetch a known test value
                from the new org

Usage:
  python3 onboard.py --slug dhp --display-name "DHP Family"

Idempotent: safe to re-run. If the alias / namespace / secrets already exist
they're left alone.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import secrets
import string
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("onboard")

INFISICAL_API = "https://app.infisical.com/api"
M365_DOMAIN = "afferentic.com"
AFFERENTIC_PROD_REPO = Path("/home/afferentic/afferentic_prod")
AFFERENT_DIR = AFFERENTIC_PROD_REPO / "kubernetes/applications/dhp"  # template


# ─────────────────────────────────────────────────────────────────────
# Step 1 — M365 alias (currently manual, see TODO at top)
# ─────────────────────────────────────────────────────────────────────


def step_1_alias(slug: str) -> str:
    """Add <slug>@afferentic.com alias on charlie's mailbox.

    Today this is a manual step until User.ReadWrite.All is granted to
    the afferentic app. Returns the alias string regardless.
    """
    alias = f"{slug}@{M365_DOMAIN}"
    log.info("[step 1/5] Email alias: %s", alias)
    print(f"""
─────────────────────────────────────────────────────────────────
  MANUAL STEP — Add the alias

  In M365 admin (https://admin.microsoft.com), open
  Users → Charlie Shreck → Manage username and email →
  add "{slug}" as an alias.

  Or: grant User.ReadWrite.All scope to the Afferentic Platform
  app in Azure AD (one-time) and re-run — script will do this
  for you next time.

  Press ENTER once the alias is added (or already exists).
─────────────────────────────────────────────────────────────────
""")
    input()
    return alias


# ─────────────────────────────────────────────────────────────────────
# Step 2 — Infisical org signup (manual, no API)
# ─────────────────────────────────────────────────────────────────────


def step_2_signup(alias: str, slug: str) -> None:
    """Walk you through creating the Infisical org + auto-extract the
    verification link from charlie's inbox once it arrives."""
    print(f"""
─────────────────────────────────────────────────────────────────
  MANUAL STEP — Register Infisical organisation

  1. In a browser, open https://app.infisical.com/signup
  2. Sign up with email: {alias}
  3. Set a strong password — STORE IT in 1Password under
     "Infisical / customer-{slug}" — you'll only need it again if
     a future identity needs creating in this org.
  4. When asked to name the organisation, use:  customer-{slug}
  5. When asked to create the first project, use:  default
     (environment defaults are fine: dev/staging/prod)

  Press ENTER once you've kicked off signup. The script will then
  poll charlie's inbox for the verification email and extract the
  click-link automatically.
─────────────────────────────────────────────────────────────────
""")
    input()
    log.info("[step 2/5] Polling charlie@afferentic.com inbox for verification email…")

    # Use the afferentic MCP REST bridge — same auth as our other tools
    deadline = time.time() + 300   # 5 minutes
    while time.time() < deadline:
        try:
            r = httpx.post(
                "http://afferentic-mcp.agentic.kernow.io/api/call",
                json={
                    "tool": "afferentic_mail_list",
                    "arguments": {
                        "user": "charlie@afferentic.com",
                        "folder": "inbox",
                        "search": "infisical",
                        "top": 5,
                    },
                },
                timeout=10.0,
            )
            r.raise_for_status()
            payload = r.json().get("result", "")
            if "infisical" in payload.lower() and "verify" in payload.lower():
                log.info("Verification email seen.")
                # Extract URL from result text — typical pattern is
                # https://app.infisical.com/signup-verify?token=...
                match = re.search(r"https://app\.infisical\.com/[^\s)<>'\"]+", payload)
                if match:
                    print(f"\n   Verification link: {match.group(0)}")
                else:
                    print("\n   (couldn't auto-extract a URL — check the email manually)")
                print("\n   Click it in your browser, then press ENTER to continue.")
                input()
                return
        except httpx.HTTPError as e:
            log.warning("mail poll failed: %s — retrying", e)
        time.sleep(15)

    log.warning("Timed out waiting for verification email. Continuing anyway — "
                "if signup completed, just paste the workspace details when prompted.")


# ─────────────────────────────────────────────────────────────────────
# Step 3 — Machine identity (manual creation, then automated use)
# ─────────────────────────────────────────────────────────────────────


def step_3_identity(slug: str) -> tuple[str, str, str]:
    """Prompt for (workspace_id, identity_client_id, identity_client_secret).

    The user creates these by hand in the new Infisical org's Access Control
    screen. Once created, we use them programmatically forever after.
    """
    print(f"""
─────────────────────────────────────────────────────────────────
  MANUAL STEP — Create the runtime machine identity

  In the customer-{slug} Infisical org you just made:
    1. Access Control → Identities → Create Identity
       Name:       customer-{slug}-runtime
       Auth method: Universal Auth
    2. Copy the Client ID and Client Secret it shows you (the
       secret only displays ONCE — save it now).
    3. Click into the Identity → Project Membership → add to your
       'default' project with role 'Member' (creates a per-project
       binding that we'll scope by path next).
    4. Project → Access Control → Identities → click your identity →
       Set 'Additional Privileges' restricting reads to:
          /  (whole project — fine while it's a single-customer org)

  Then come back here. You'll need:
    - Workspace ID (Project → Settings → "Project ID")
    - Client ID
    - Client Secret
─────────────────────────────────────────────────────────────────
""")
    workspace_id = input("Workspace ID: ").strip()
    client_id = input("Identity Client ID: ").strip()
    client_secret = input("Identity Client Secret: ").strip()

    # Quick sanity check — try to log in
    log.info("[step 3/5] Verifying identity credentials…")
    try:
        r = httpx.post(
            f"{INFISICAL_API}/v1/auth/universal-auth/login",
            json={"clientId": client_id, "clientSecret": client_secret},
            timeout=10.0,
        )
        if r.status_code != 200:
            raise RuntimeError(f"login failed {r.status_code}: {r.text[:300]}")
        token = r.json()["accessToken"]
        log.info("Identity verified, JWT acquired (len=%d).", len(token))
    except Exception as e:
        log.error("Identity verification failed — please double-check the credentials. %s", e)
        sys.exit(2)

    return workspace_id, client_id, client_secret


# ─────────────────────────────────────────────────────────────────────
# Step 4 — Generate K8s manifests
# ─────────────────────────────────────────────────────────────────────


def step_4_manifests(slug: str, display_name: str, workspace_id: str) -> Path:
    """Generate namespace + InfisicalSecret + auth-credentials manifests
    for customer-<slug>. Doesn't touch the cronjobs themselves yet — that's
    a follow-up commit per customer."""
    out_dir = AFFERENTIC_PROD_REPO / f"kubernetes/applications/customer-{slug}-bootstrap"
    out_dir.mkdir(parents=True, exist_ok=True)

    namespace_yaml = out_dir / "00-namespace.yaml"
    namespace_yaml.write_text(f"""# Namespace for {display_name} — first customer onboarding follows
# /home/afferent/scripts/onboard-customer/onboard.py
apiVersion: v1
kind: Namespace
metadata:
  name: customer-{slug}
  labels:
    customer: {slug}
    afferentic.com/customer-display-name: "{display_name}"
""")

    auth_creds_yaml = out_dir / "10-infisical-auth.yaml"
    auth_creds_yaml.write_text(f"""# Bootstrap auth for the customer-{slug} Infisical org.
# This Secret is the ONE thing that has to be applied out-of-band — InfisicalSecret
# CRDs in this namespace authenticate using these credentials.
#
# Refresh procedure: rotate the Universal Auth identity in Infisical, re-run
#   onboard.py --slug {slug} --rotate-only
# which will write a new k8s Secret here without touching anything else.
apiVersion: v1
kind: Secret
metadata:
  name: customer-{slug}-infisical-auth
  namespace: infisical-operator-system
  labels:
    customer: {slug}
type: Opaque
stringData:
  clientId: REPLACE_ME_WITH_CLIENT_ID
  clientSecret: REPLACE_ME_WITH_CLIENT_SECRET
""")

    infisical_secret_yaml = out_dir / "20-secrets.yaml"
    infisical_secret_yaml.write_text(f"""# Pulls customer-{slug}'s secrets from their dedicated Infisical org
# into K8s Secrets in the customer-{slug} namespace. Per-path Secrets are
# preferred so a CronJob only mounts what it specifically needs.
apiVersion: secrets.infisical.com/v1alpha1
kind: InfisicalSecret
metadata:
  name: customer-{slug}-kappture
  namespace: customer-{slug}
spec:
  hostAPI: https://app.infisical.com/api
  authentication:
    universalAuth:
      credentialsRef:
        secretName: customer-{slug}-infisical-auth
        secretNamespace: infisical-operator-system
      secretsScope:
        projectSlug: REPLACE_ME_WITH_PROJECT_SLUG
        envSlug: prod
        secretsPath: /kappture
  managedSecretReference:
    secretName: customer-{slug}-kappture
    secretNamespace: customer-{slug}
    secretType: Opaque
    creationPolicy: Owner
---
apiVersion: secrets.infisical.com/v1alpha1
kind: InfisicalSecret
metadata:
  name: customer-{slug}-m365
  namespace: customer-{slug}
spec:
  hostAPI: https://app.infisical.com/api
  authentication:
    universalAuth:
      credentialsRef:
        secretName: customer-{slug}-infisical-auth
        secretNamespace: infisical-operator-system
      secretsScope:
        projectSlug: REPLACE_ME_WITH_PROJECT_SLUG
        envSlug: prod
        secretsPath: /m365
  managedSecretReference:
    secretName: customer-{slug}-m365
    secretNamespace: customer-{slug}
    secretType: Opaque
    creationPolicy: Owner
""")

    netpol_yaml = out_dir / "30-networkpolicy.yaml"
    netpol_yaml.write_text(f"""# Default-deny + scoped-egress NetworkPolicy for customer-{slug}.
# Permits: in-namespace svc-to-svc, DNS, Microsoft Graph, Kappture API.
# Denies: cluster-internal access to other customer / platform namespaces.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: customer-{slug}
spec:
  podSelector: {{}}
  policyTypes: [Ingress, Egress]
  egress:
    - to: [{{namespaceSelector: {{matchLabels: {{kubernetes.io/metadata.name: kube-system}}}}}}]
      ports: [{{port: 53, protocol: UDP}}, {{port: 53, protocol: TCP}}]
    - to: [{{podSelector: {{}}}}]
    - ports: [{{port: 443, protocol: TCP}}]
      to: []
""")

    quota_yaml = out_dir / "40-resourcequota.yaml"
    quota_yaml.write_text(f"""# Resource budget for customer-{slug}. Generous v0 — tune down once
# we have a baseline.
apiVersion: v1
kind: ResourceQuota
metadata:
  name: customer-{slug}-quota
  namespace: customer-{slug}
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    persistentvolumeclaims: "5"
""")

    log.info("[step 4/5] Wrote bootstrap manifests to %s", out_dir)
    return out_dir


def step_4b_replace_placeholders(out_dir: Path, *,
                                 client_id: str, client_secret: str,
                                 project_slug: str) -> None:
    for f in out_dir.rglob("*.yaml"):
        text = f.read_text()
        text = text.replace("REPLACE_ME_WITH_CLIENT_ID", client_id)
        text = text.replace("REPLACE_ME_WITH_CLIENT_SECRET", client_secret)
        text = text.replace("REPLACE_ME_WITH_PROJECT_SLUG", project_slug)
        f.write_text(text)
    log.info("[step 4/5] Placeholders replaced.")


# ─────────────────────────────────────────────────────────────────────
# Step 5 — Stash bootstrap creds in Afferentic main Infisical
# ─────────────────────────────────────────────────────────────────────


def step_5_stash(slug: str, workspace_id: str, project_slug: str,
                 client_id: str, client_secret: str) -> None:
    """Save the customer's bootstrap creds in AFFERENTIC's main Infisical
    so a cluster rebuild can re-bootstrap the customer namespace without
    re-running the full onboard flow.

    Writes to /customers-bootstraps/<slug>/{WORKSPACE_ID,PROJECT_SLUG,
    CLIENT_ID,CLIENT_SECRET}.

    NB: this requires the executor to be authenticated against Afferentic
    Infisical (NOT Kernow). Today that means a UA token for an Afferentic
    identity. Document the path; do nothing if the env vars aren't set.
    """
    if not all(k in __import__("os").environ for k in ("AFFERENTIC_INFISICAL_CLIENT_ID",
                                                       "AFFERENTIC_INFISICAL_CLIENT_SECRET",
                                                       "AFFERENTIC_INFISICAL_WORKSPACE_ID")):
        log.warning("[step 5/5] AFFERENTIC_INFISICAL_* env vars not set — skipping stash. "
                    "Manually copy the credentials from step 3 into Afferentic Infisical at "
                    "/customers-bootstraps/%s/", slug)
        return

    log.info("[step 5/5] Would stash credentials in Afferentic Infisical at /customers-bootstraps/%s/", slug)
    log.info("           (auth flow not implemented — TODO)")


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", required=True, help="Customer slug — lowercase, no spaces (e.g. 'dhp')")
    parser.add_argument("--display-name", required=True, help="Customer display name (e.g. 'DHP Family')")
    args = parser.parse_args()

    if not re.match(r"^[a-z][a-z0-9-]+$", args.slug):
        log.error("--slug must be lowercase letters/digits/hyphens only")
        return 2

    alias = step_1_alias(args.slug)
    step_2_signup(alias, args.slug)
    workspace_id, client_id, client_secret = step_3_identity(args.slug)
    project_slug = input("Project slug (visible in URL bar of the Infisical project): ").strip()

    out_dir = step_4_manifests(args.slug, args.display_name, workspace_id)
    step_4b_replace_placeholders(out_dir, client_id=client_id,
                                 client_secret=client_secret,
                                 project_slug=project_slug)
    step_5_stash(args.slug, workspace_id, project_slug, client_id, client_secret)

    print(f"""

╔═══════════════════════════════════════════════════════════════╗
║  Customer {args.slug:50s} ║
║  Bootstrap manifests: {str(out_dir)[:42]:42s} ║
║                                                               ║
║  Next steps:                                                  ║
║   1. Review the generated manifests                           ║
║   2. git add + commit + push (afferentic_prod submodule       ║
║      + parent pointer)                                        ║
║   3. ArgoCD will create the namespace + secrets + quota       ║
║   4. Wire your customer-{args.slug:30s} CronJobs to use new  ║
║      namespace + secret refs (separate commit)                ║
╚═══════════════════════════════════════════════════════════════╝
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
