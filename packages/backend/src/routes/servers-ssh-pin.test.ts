import { describe, expect, it } from 'vitest';
import { sshPinOutdated, sshSessionChanged } from './servers.routes.js';

const CURRENT = { host: 'ts.example.net', sshPort: 10022 };

describe('sshPinOutdated', () => {
  it('keeps the pin when neither host nor SSH port is in the update', () => {
    expect(sshPinOutdated(CURRENT, {})).toBe(false);
  });

  it('keeps the pin when the form resubmits the same host and port', () => {
    // The edit dialog sends every field back, the port as a number or string.
    expect(sshPinOutdated(CURRENT, { host: 'ts.example.net', sshPort: 10022 })).toBe(false);
    expect(sshPinOutdated(CURRENT, { host: ' ts.example.net ', sshPort: '10022' })).toBe(false);
  });

  it('clears the pin when the host changes', () => {
    expect(sshPinOutdated(CURRENT, { host: 'new.example.net' })).toBe(true);
  });

  it('clears the pin when the SSH port changes', () => {
    expect(sshPinOutdated(CURRENT, { sshPort: 10023 })).toBe(true);
  });
});

describe('sshSessionChanged', () => {
  const SERVER = { ...CURRENT, sshUsername: 'serveradmin' };

  it('ignores updates that only touch WebQuery settings', () => {
    expect(sshSessionChanged(SERVER, { name: 'x', webqueryPort: 10080, apiKey: 'enc', useHttps: true })).toBe(false);
  });

  it('ignores a save that resubmits the unchanged SSH fields', () => {
    // What the edit dialog sends when only the name was changed.
    expect(sshSessionChanged(SERVER, { name: 'x', host: 'ts.example.net', sshPort: 10022, sshUsername: 'serveradmin' })).toBe(false);
  });

  it('restarts sessions when SSH credentials, endpoint or pin change', () => {
    expect(sshSessionChanged(SERVER, { sshPassword: 'enc' })).toBe(true);
    expect(sshSessionChanged(SERVER, { sshUsername: 'admin2' })).toBe(true);
    expect(sshSessionChanged(SERVER, { host: 'new.example.net' })).toBe(true);
    expect(sshSessionChanged(SERVER, { sshPort: 10023 })).toBe(true);
    expect(sshSessionChanged(SERVER, { sshHostKeyFp: null })).toBe(true);
  });
});
