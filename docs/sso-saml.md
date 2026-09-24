# SSO / SAML configuration

Optional SP-initiated SAML 2.0 single sign-on that runs **alongside** local login. Configure it under **Settings → SSO / SAML** (admin only). SSO only becomes active once **Enable SSO** is on **and** both the **IdP SSO URL** and **IdP signing certificate** are filled in — until then the "Sign in via SSO" button stays hidden and the SAML endpoints are inert.

**Give these to your identity provider (shown read-only in the tab):**

| Value | What it is | How it is built |
|-------|------------|-----------------|
| SP metadata URL | The service-provider EntityID / audience the IdP must target | `<FRONTEND_URL>/api/auth/saml/metadata` |
| ACS URL | Assertion Consumer Service — where the IdP POSTs the SAML response | `<FRONTEND_URL>/api/auth/saml/acs` |

`<FRONTEND_URL>` is the `FRONTEND_URL` environment variable (your public app origin).

**Fields:**

| Field | Description | Default | Required | Admissible values |
|-------|-------------|---------|----------|-------------------|
| Enable SSO (SAML) | Master switch. When off, SSO is hidden and all SAML endpoints return 404 | `off` | — | on / off |
| IdP Entity ID | The identity provider's issuer / EntityID. Informational for reference; the assertion is trusted via the certificate + audience binding | empty | no | any string (usually a URL/URN) |
| IdP SSO URL | The IdP's SAML **redirect** SSO endpoint where the login request (AuthnRequest) is sent | empty | **yes** (to enable) | an `https://` URL |
| IdP signing certificate | The IdP's X.509 **public** signing certificate used to verify the assertion signature. Write-only: stored encrypted, shown only as set/not-set | empty | **yes** (to enable) | PEM (`-----BEGIN CERTIFICATE-----…`) or bare base64 body (auto-wrapped) |
| Automatically provision accounts | Create a local account on first successful SSO login (JIT). When off, a SAML login for an unknown account is rejected | `on` | no | on / off |
| Default role for SSO accounts | Role assigned when no admin mapping matches (see role attribute below) | `viewer` | no | `viewer` or `admin` |
| Attribute: username | Assertion attribute mapped to the account username. If missing, falls back to the email local-part, then the NameID | Authentik username claim (`http://schemas.goauthentik.io/2021/02/saml/username`) | no | any attribute name your IdP sends |
| Attribute: email | Assertion attribute mapped to the email | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | no | any attribute name |
| Attribute: display name | Assertion attribute mapped to the display name (falls back to the username) | Authentik displayname claim (`http://schemas.goauthentik.io/2021/02/saml/displayname`) | no | any attribute name |
| Attribute: role / group | Assertion attribute (often `groups`) whose values are checked for the admin mapping. Leave empty to give every SSO user the default role | empty | no | any attribute name |
| Value granting the admin role | If this exact value appears in the role/group attribute, the account becomes `admin`; otherwise it gets the default role | empty | no | the exact group/role string from your IdP (e.g. `ts6-admins`) |

**Behaviour notes:**

- **Identity key:** accounts are matched on the SAML **NameID** — configure a **persistent** NameID format on the IdP. A *transient* NameID changes every login and would create a new account each time.
- **Role sync:** the role is **re-evaluated on every login** (the IdP is authoritative). A manual promotion made inside the app is overwritten at the next SSO login.
- **MFA:** the app's MFA gate still applies after a valid assertion (if the account has MFA enabled). SSO accounts have **no local password** and cannot use the local password / change-password flows.
- **Security posture (v1):** assertion signature is **required**, the audience must equal the SP metadata URL, and `InResponseTo` replay validation is enforced. The SP does **not** sign its AuthnRequests. Importing IdP metadata by URL/XML is not wired yet — enter the SSO URL and certificate manually.

**Authentik quick mapping:** *IdP SSO URL* = the provider's **SSO URL (Redirect)**; *IdP signing certificate* = the provider's **Signing Certificate**; *IdP Entity ID* = the provider's **Issuer**. For admin mapping, expose a groups attribute (Property Mapping) and set **Value granting the admin role** to your admin group's name.
