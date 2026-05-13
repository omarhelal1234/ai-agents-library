// App-layer encryption for secrets stored in the Supabase state DB.
// PBKDF2-SHA256 (200k iterations) → 256-bit AES-GCM. All ops use Web Crypto.
// No plaintext ever leaves the browser.

const KDF_ITERATIONS = 200_000;
const KDF_HASH = "SHA-256";
const KEY_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;

function bytesToB64(bytes) {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: KDF_ITERATIONS, hash: KDF_HASH },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt a string with a passphrase. Returns base64 ciphertext + iv + salt.
export async function encrypt(plaintext, passphrase) {
  if (typeof plaintext !== "string") throw new Error("encrypt: plaintext must be a string");
  if (!passphrase) throw new Error("encrypt: passphrase required");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  return {
    ciphertext: bytesToB64(ciphertext),
    iv: bytesToB64(iv),
    salt: bytesToB64(salt),
    algo: "AES-GCM",
    kdf: `PBKDF2-${KDF_HASH.replace("-", "")}-${KDF_ITERATIONS}`,
  };
}

// Decrypt a record produced by encrypt(). Returns the original string.
// Throws on wrong passphrase or tampered ciphertext.
export async function decrypt({ ciphertext, iv, salt }, passphrase) {
  if (!passphrase) throw new Error("decrypt: passphrase required");
  const key = await deriveKey(passphrase, b64ToBytes(salt));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(iv) },
      key,
      b64ToBytes(ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch (e) {
    throw new Error("Decryption failed — wrong passphrase or corrupted data");
  }
}

// ----- Passphrase cache (in-memory only) -----
// Held in module scope. Cleared on tab close. Never written to localStorage.
let _passphrase = null;
let _verifiedAt = 0;
const PASSPHRASE_TTL_MS = 30 * 60 * 1000;   // re-prompt after 30 minutes of inactivity

export function setPassphrase(p) {
  _passphrase = p || null;
  _verifiedAt = p ? Date.now() : 0;
}
export function getPassphrase() {
  if (!_passphrase) return null;
  if (Date.now() - _verifiedAt > PASSPHRASE_TTL_MS) {
    _passphrase = null;
    return null;
  }
  _verifiedAt = Date.now();   // touch on each access
  return _passphrase;
}
export function clearPassphrase() {
  _passphrase = null;
  _verifiedAt = 0;
}
export function hasPassphrase() {
  return !!getPassphrase();
}

// Quick verify: try decrypting a known canary record. Returns true on success.
export async function verifyPassphrase(canaryRecord, passphrase) {
  if (!canaryRecord) return true;   // nothing to verify against
  try {
    await decrypt(canaryRecord, passphrase);
    return true;
  } catch {
    return false;
  }
}
