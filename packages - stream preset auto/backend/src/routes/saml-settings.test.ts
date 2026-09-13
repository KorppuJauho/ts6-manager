import { describe, it, expect } from 'vitest';
import { sanitizeSamlSettingsInput } from './saml.routes.js';

describe('sanitizeSamlSettingsInput', () => {
  it('coerce enabled/autoProvision en booléen', () => {
    const out = sanitizeSamlSettingsInput({ enabled: 'true', autoProvision: 0 });
    expect(out.enabled).toBe(true);
    expect(out.autoProvision).toBe(false);
  });
  it('normalise defaultRole invalide vers viewer', () => {
    expect(sanitizeSamlSettingsInput({ defaultRole: 'root' }).defaultRole).toBe('viewer');
    expect(sanitizeSamlSettingsInput({ defaultRole: 'admin' }).defaultRole).toBe('admin');
  });
  it('convertit les chaînes vides en null pour les champs optionnels', () => {
    const out = sanitizeSamlSettingsInput({ attrRole: '', roleAdminValue: '' });
    expect(out.attrRole).toBeNull();
    expect(out.roleAdminValue).toBeNull();
  });
  it('ignore les clés inconnues', () => {
    expect('hacker' in sanitizeSamlSettingsInput({ hacker: 1 })).toBe(false);
  });
});
