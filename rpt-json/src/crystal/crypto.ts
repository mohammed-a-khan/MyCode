/**
 * Stream encryption used by Crystal Reports report streams.
 *
 * The engine uses AES-128 in CFB-128 mode. Its only quirk is byte order: each 16-byte block is
 * treated as four little-endian 32-bit words, so every 4-byte group is reversed before and after
 * a standard AES block encryption. Two fixed engine keys are used: one for the report definition
 * (Contents, PromptManager, ReportParametersStream) and one for the query engine (QESession).
 *
 * The AES implementation below is a straightforward FIPS-197 encryptor (CFB only needs the
 * forward direction). The S-box is generated from its GF(2^8) definition rather than tabulated.
 */

/** Multiplication by x in GF(2^8) modulo the AES polynomial x^8 + x^4 + x^3 + x + 1. */
const gfDouble = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;

/** The AES S-box: multiplicative inverse in GF(2^8) followed by the FIPS-197 affine transform. */
const SBOX = (() => {
  const box = new Uint8Array(256);
  const rotl8 = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff;
  // Walk the multiplicative group with generator 3 (p) while q tracks its inverse (q = p^-1).
  let p = 1;
  let q = 1;
  do {
    p = p ^ gfDouble(p);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    box[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  box[0] = 0x63;
  return box;
})();

const ROUNDS = 10;

/** FIPS-197 key expansion for a 128-bit key: 11 round keys of 16 bytes, concatenated. */
export function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
  const w = new Uint8Array(16 * (ROUNDS + 1));
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < w.length; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      // RotWord, SubWord, then XOR the round constant into the first byte.
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = gfDouble(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

/** Encrypts one 16-byte block in place with an expanded key (column-major state, as in FIPS-197). */
export function aesEncryptBlock(state: Uint8Array, roundKeys: Uint8Array): void {
  const addRoundKey = (round: number) => {
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[round * 16 + i];
  };
  const subBytesShiftRows = () => {
    // Byte (row r, column c) lives at index 4c + r; row r rotates left by r columns.
    const s = Uint8Array.from(state);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) state[4 * c + r] = SBOX[s[4 * ((c + r) % 4) + r]];
    }
  };
  const mixColumns = () => {
    for (let c = 0; c < 16; c += 4) {
      const [a0, a1, a2, a3] = [state[c], state[c + 1], state[c + 2], state[c + 3]];
      const all = a0 ^ a1 ^ a2 ^ a3;
      state[c] ^= all ^ gfDouble(a0 ^ a1);
      state[c + 1] ^= all ^ gfDouble(a1 ^ a2);
      state[c + 2] ^= all ^ gfDouble(a2 ^ a3);
      state[c + 3] ^= all ^ gfDouble(a3 ^ a0);
    }
  };

  addRoundKey(0);
  for (let round = 1; round < ROUNDS; round++) {
    subBytesShiftRows();
    mixColumns();
    addRoundKey(round);
  }
  subBytesShiftRows();
  addRoundKey(ROUNDS);
}

/** Reverses each 4-byte group in place: Crystal's little-endian word view of an AES block. */
function swapWords(block: Uint8Array): void {
  for (let i = 0; i < 16; i += 4) {
    [block[i], block[i + 1], block[i + 2], block[i + 3]] = [block[i + 3], block[i + 2], block[i + 1], block[i]];
  }
}

export interface StreamCipher {
  /** Encrypts one block the way the engine does (used to produce the CFB keystream). */
  encryptBlock(block: Uint8Array): Uint8Array;
  decrypt(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  encrypt(iv: Uint8Array, plaintext: Uint8Array): Uint8Array;
}

function createStreamCipher(key: Uint8Array): StreamCipher {
  const roundKeys = expandKey(key);
  const encryptBlock = (block: Uint8Array): Uint8Array => {
    const state = Uint8Array.from(block);
    swapWords(state);
    aesEncryptBlock(state, roundKeys);
    swapWords(state);
    return state;
  };
  // CFB-128: keystream block = E(previous ciphertext block), starting from E(IV).
  const run = (iv: Uint8Array, input: Uint8Array, decrypting: boolean): Uint8Array => {
    if (iv.length !== 16) throw new Error(`IV must be 16 bytes, got ${iv.length}`);
    const output = new Uint8Array(input.length);
    let previous = Uint8Array.from(iv);
    for (let pos = 0; pos < input.length; pos += 16) {
      const keystream = encryptBlock(previous);
      const end = Math.min(pos + 16, input.length);
      for (let i = pos; i < end; i++) output[i] = input[i] ^ keystream[i - pos];
      previous = (decrypting ? input : output).slice(pos, pos + 16);
    }
    return output;
  };
  return {
    encryptBlock,
    decrypt: (iv, ciphertext) => run(iv, ciphertext, true),
    encrypt: (iv, plaintext) => run(iv, plaintext, false),
  };
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));

/** Cipher for Contents, PromptManager and ReportParametersStream. */
export const reportCipher = createStreamCipher(hexBytes('9618dd11cd154abd3554f2bf0f76e603'));

/** Cipher for QESession. */
export const queryCipher = createStreamCipher(hexBytes('1fdfbc2a6cacf8d6650c500adcba4720'));
