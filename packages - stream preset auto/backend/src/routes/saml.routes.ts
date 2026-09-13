import { Router, Request, Response } from 'express';
import { encrypt } from '../utils/crypto.js';
import { loadSamlRuntime, acsUrl, spEntityIdDefault, normalizeCert } from '../auth/saml/saml-config.js';

export const samlRoutes: Router = Router();

const OPTIONAL_STRINGS = ['idpMetadataUrl', 'idpEntityId', 'idpSsoUrl', 'spEntityId', 'attrRole', 'roleAdminValue'];
const REQUIRED_STRINGS = ['attrUsername', 'attrEmail', 'attrDisplayName'];

/** Coerce + normalize the settings PUT body; drop unknown keys. Pure. */
export function sanitizeSamlSettingsInput(body: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.enabled !== undefined) out.enabled = !!body.enabled && body.enabled !== 'false';
  if (body.autoProvision !== undefined) out.autoProvision = !!body.autoProvision && body.autoProvision !== 'false';
  if (body.defaultRole !== undefined) out.defaultRole = body.defaultRole === 'admin' ? 'admin' : 'viewer';
  for (const k of OPTIONAL_STRINGS) if (body[k] !== undefined) out[k] = body[k] ? String(body[k]) : null;
  for (const k of REQUIRED_STRINGS) if (body[k] !== undefined && body[k]) out[k] = String(body[k]);
  return out;
}

async function getOrCreate(prisma: any) {
  return (await prisma.sAMLSettings.findFirst()) || (await prisma.sAMLSettings.create({ data: {} }));
}

samlRoutes.get('/settings', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const s = await getOrCreate(prisma);
    res.json({
      enabled: s.enabled,
      idpMetadataUrl: s.idpMetadataUrl,
      idpEntityId: s.idpEntityId,
      idpSsoUrl: s.idpSsoUrl,
      hasIdpMetadataXml: !!s.idpMetadataXml,
      hasIdpCertificate: !!s.idpCertificate,
      spEntityId: s.spEntityId || spEntityIdDefault(),
      autoProvision: s.autoProvision,
      defaultRole: s.defaultRole,
      attrUsername: s.attrUsername, attrEmail: s.attrEmail, attrDisplayName: s.attrDisplayName,
      attrRole: s.attrRole, roleAdminValue: s.roleAdminValue,
      // Read-only helpers for the admin to configure the IdP:
      spMetadataUrl: spEntityIdDefault(),
      acsUrl: acsUrl(),
    });
  } catch (err) { next(err); }
});

samlRoutes.put('/settings', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const s = await getOrCreate(prisma);
    const data = sanitizeSamlSettingsInput(req.body);

    // Secrets: accept raw values, store encrypted; empty string clears.
    if (req.body.idpMetadataXml !== undefined) {
      data.idpMetadataXml = req.body.idpMetadataXml ? encrypt(String(req.body.idpMetadataXml)) : null;
    }
    if (req.body.idpCertificate !== undefined) {
      data.idpCertificate = req.body.idpCertificate ? encrypt(normalizeCert(String(req.body.idpCertificate))) : null;
    }

    await prisma.sAMLSettings.update({ where: { id: s.id }, data });
    await loadSamlRuntime(prisma); // hot reload
    res.json({ ok: true });
  } catch (err) { next(err); }
});
