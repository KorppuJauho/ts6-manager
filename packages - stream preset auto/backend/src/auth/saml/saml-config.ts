import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { config } from '../../config.js';
import { decrypt } from '../../utils/crypto.js';

export interface SamlRuntimeSettings {
  enabled: boolean;
  spEntityId: string;
  autoProvision: boolean;
  defaultRole: string;
  attrUsername: string;
  attrEmail: string;
  attrDisplayName: string;
  attrRole: string | null;
  roleAdminValue: string | null;
}

let samlInstance: SAML | null = null;
let runtime: SamlRuntimeSettings | null = null;

/** Backend-visible ACS URL. FRONTEND_URL is the public origin; ACS is a backend path proxied under /api. */
export function acsUrl(): string {
  return `${config.frontendUrl.replace(/\/$/, '')}/api/auth/saml/acs`;
}

export function spEntityIdDefault(): string {
  return `${config.frontendUrl.replace(/\/$/, '')}/api/auth/saml/metadata`;
}

/** Wrap a bare base64 cert body in PEM markers; leave already-wrapped PEM as-is. */
export function normalizeCert(pem: string): string {
  const trimmed = (pem || '').trim();
  if (trimmed.includes('BEGIN CERTIFICATE')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try { return decrypt(value); } catch { return value; }
}

/** Reload the in-memory SAML instance + normalized settings from the DB. Call at boot and after settings PUT. */
export async function loadSamlRuntime(prisma: any): Promise<void> {
  const s = await prisma.sAMLSettings.findFirst();
  if (!s || !s.enabled || !s.idpSsoUrl || !s.idpCertificate) {
    samlInstance = null;
    runtime = s ? {
      enabled: !!s.enabled, spEntityId: s.spEntityId || spEntityIdDefault(), autoProvision: s.autoProvision,
      defaultRole: s.defaultRole, attrUsername: s.attrUsername, attrEmail: s.attrEmail,
      attrDisplayName: s.attrDisplayName, attrRole: s.attrRole, roleAdminValue: s.roleAdminValue,
    } : null;
    return;
  }
  const cert = normalizeCert(safeDecrypt(s.idpCertificate) || '');
  const spEntityId = s.spEntityId || spEntityIdDefault();
  samlInstance = new SAML({
    callbackUrl: acsUrl(),
    entryPoint: s.idpSsoUrl,
    issuer: spEntityId,
    idpCert: cert,
    wantAssertionsSigned: true,
    audience: spEntityId,
    validateInResponseTo: ValidateInResponseTo.always,
  });
  runtime = {
    enabled: true, spEntityId, autoProvision: s.autoProvision, defaultRole: s.defaultRole,
    attrUsername: s.attrUsername, attrEmail: s.attrEmail, attrDisplayName: s.attrDisplayName,
    attrRole: s.attrRole, roleAdminValue: s.roleAdminValue,
  };
}

export function getSaml(): SAML | null { return samlInstance; }
export function isSamlEnabled(): boolean { return !!runtime?.enabled; }
export function getRuntimeSettings(): SamlRuntimeSettings | null { return runtime; }
