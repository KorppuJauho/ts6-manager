import { describe, it, expect } from 'vitest';
import { deriveKeyNonce, eaxEncrypt, eaxDecrypt } from './crypto.js';

// These tests pin the cryptographic premise behind the incoming-generation retry
// in client.ts handleIncomingPacket: the TS3 server bumps its per-type generation
// each time its 16-bit packet id wraps, and a packet sealed at one generation can
// only be opened at that generation. The old code always decrypted with
// generation 0, so once the server wrapped, packets were silently dropped. The fix
// retries with generation + 1 on a decrypt failure and persists the bump.
describe('per-generation key/nonce derivation', () => {
  const iv = Buffer.alloc(20, 0xab); // fixed shared-secret layout for a deterministic test
  const packetId = 100;
  const packetType = 2; // Command

  it('derives a different key and nonce for each generation', () => {
    const g0 = deriveKeyNonce(true, packetId, 0, packetType, iv);
    const g1 = deriveKeyNonce(true, packetId, 1, packetType, iv);
    expect(g0.key.equals(g1.key)).toBe(false);
    expect(g0.nonce.equals(g1.nonce)).toBe(false);
  });

  it('a packet sealed at generation 1 fails at generation 0 and succeeds at generation 1', () => {
    const header = Buffer.from([0x00, 0x64, 0x02]); // arbitrary S2C-style header (associated data)
    const plaintext = Buffer.from('notifyclientmoved clid=7 ctid=3', 'utf8');

    // Server sealed this packet after its 16-bit id wrapped → generation 1.
    const g1 = deriveKeyNonce(true, packetId, 1, packetType, iv);
    const { ciphertext, mac } = eaxEncrypt(g1.key, g1.nonce, header, plaintext);

    // Old buggy behaviour: always generation 0 → MAC mismatch → packet dropped.
    const g0 = deriveKeyNonce(true, packetId, 0, packetType, iv);
    expect(eaxDecrypt(g0.key, g0.nonce, header, ciphertext, mac)).toBeNull();

    // The retry (generation + 1) recovers the correct key and decrypts cleanly.
    const recovered = eaxDecrypt(g1.key, g1.nonce, header, ciphertext, mac);
    expect(recovered).not.toBeNull();
    expect(recovered!.equals(plaintext)).toBe(true);
  });
});
