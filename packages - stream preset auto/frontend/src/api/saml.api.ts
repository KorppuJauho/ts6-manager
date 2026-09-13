import api from './client';

export interface SamlSettings {
  enabled: boolean;
  idpMetadataUrl: string | null;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  hasIdpMetadataXml: boolean;
  hasIdpCertificate: boolean;
  spEntityId: string;
  autoProvision: boolean;
  defaultRole: 'admin' | 'viewer';
  attrUsername: string;
  attrEmail: string;
  attrDisplayName: string;
  attrRole: string | null;
  roleAdminValue: string | null;
  spMetadataUrl: string;
  acsUrl: string;
}

export const samlApi = {
  settings: (): Promise<SamlSettings> => api.get('/saml/settings').then((r) => r.data),
  updateSettings: (data: Partial<SamlSettings> & { idpMetadataXml?: string; idpCertificate?: string }) =>
    api.put('/saml/settings', data).then((r) => r.data),
};
