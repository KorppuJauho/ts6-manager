import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';
import { getSaml, getRuntimeSettings, isSamlEnabled } from '../auth/saml/saml-config.js';
import { buildSamlProfile } from '../auth/saml/saml-user.js';
import { resolveSamlAccount } from '../auth/saml/resolve-account.js';
import { createSsoCode, consumeSsoCode } from '../auth/saml/sso-code-store.js';
import { gateAfterPassword } from '../auth/session.js';

export const samlAuthRoutes: Router = Router();

const acsLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
const loginBase = () => config.frontendUrl.replace(/\/$/, '');

samlAuthRoutes.get('/status', (_req, res) => {
  res.json({ enabled: isSamlEnabled() });
});

samlAuthRoutes.get('/metadata', (_req, res, next) => {
  try {
    const saml = getSaml();
    if (!saml) throw new AppError(404, 'SAML disabled');
    const xml = saml.generateServiceProviderMetadata(null, null);
    res.type('application/xml').send(xml);
  } catch (err) { next(err); }
});

samlAuthRoutes.get('/login', async (req: Request, res: Response, next) => {
  try {
    const saml = getSaml();
    if (!saml) throw new AppError(404, 'SAML disabled');
    const url = await saml.getAuthorizeUrlAsync('', undefined, {});
    res.redirect(url);
  } catch (err) { next(err); }
});

samlAuthRoutes.post('/acs', acsLimiter, async (req: Request, res: Response) => {
  try {
    const saml = getSaml();
    const rt = getRuntimeSettings();
    if (!saml || !rt) throw new AppError(404, 'SAML disabled');
    const prisma = req.app.locals.prisma;

    const { profile } = await saml.validatePostResponseAsync(req.body);
    if (!profile || !profile.nameID) throw new AppError(401, 'Invalid SAML assertion');

    // node-saml exposes attributes both nested under `.attributes` and flattened
    // onto the profile itself; prefer the nested map, fall back to the profile
    // object (still keyed by attribute name) if the assertion carried none.
    const attributes = (profile.attributes as Record<string, unknown> | undefined)
      ?? (profile as unknown as Record<string, unknown>);
    const resolvedProfile = buildSamlProfile({ nameID: profile.nameID, attributes }, rt);

    const account = await resolveSamlAccount(prisma, resolvedProfile, { autoProvision: rt.autoProvision });
    if ('error' in account) {
      return res.redirect(`${loginBase()}/login/sso?error=${account.error}`);
    }
    const code = createSsoCode(account.user.id);
    res.redirect(`${loginBase()}/login/sso?code=${code}`);
  } catch (err) {
    // Never leak validation details to the browser; log server-side, redirect with a generic error.
    console.error('[SAML] ACS error:', (err as Error)?.message);
    res.redirect(`${loginBase()}/login/sso?error=saml_failed`);
  }
});

const exchangeLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
samlAuthRoutes.post('/exchange', exchangeLimiter, async (req: Request, res: Response, next) => {
  try {
    const { code } = req.body;
    if (!code) throw new AppError(400, 'Code required');
    const userId = consumeSsoCode(String(code));
    if (!userId) throw new AppError(401, 'Invalid or expired code');
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.enabled) throw new AppError(401, 'Account unavailable');
    const result = await gateAfterPassword(prisma, user);
    res.json(result);
  } catch (err) { next(err); }
});
