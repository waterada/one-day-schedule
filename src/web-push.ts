/// <reference types="@cloudflare/workers-types" />

// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) on Workers' Web Crypto.
// No external dependencies.

export interface VapidKeys {
  publicKey: string;   // base64url, 65-byte uncompressed P-256 point
  privateKey: string;  // base64url, 32-byte raw scalar d
  subject: string;     // e.g. "mailto:you@example.com"
}

export interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };  // both base64url
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  expired: boolean;  // 404/410 — subscription should be discarded
}

const enc = new TextEncoder();

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importVapidSigningKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64uDecode(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("invalid_vapid_public_key");
  const d = b64uDecode(vapid.privateKey);
  if (d.length !== 32) throw new Error("invalid_vapid_private_key");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64uEncode(pub.subarray(1, 33)),
      y: b64uEncode(pub.subarray(33, 65)),
      d: b64uEncode(d),
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function signVapidJwt(audience: string, vapid: VapidKeys): Promise<string> {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject,
  })));
  const signingInput = `${header}.${claims}`;
  const key = await importVapidSigningKey(vapid);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${b64uEncode(sig)}`;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = await crypto.subtle.sign("HMAC", k, data);
  return new Uint8Array(out);
}

async function hkdfExpandOneBlock(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  // RFC 5869 single-block expand (length must be <= 32 for SHA-256).
  const t = new Uint8Array(info.length + 1);
  t.set(info, 0);
  t[info.length] = 0x01;
  const block = await hmacSha256(prk, t);
  return block.subarray(0, length);
}

async function encryptAes128Gcm(
  plaintext: Uint8Array,
  uaP256dh: Uint8Array,   // 65 bytes uncompressed
  uaAuthSecret: Uint8Array,  // 16 bytes
): Promise<Uint8Array> {
  if (uaP256dh.length !== 65 || uaP256dh[0] !== 0x04) throw new Error("invalid_p256dh");

  // Ephemeral application-server keypair (per push).
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  // exportKey("raw", ...) always returns ArrayBuffer; the union type comes from the overload signature.
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey) as ArrayBuffer);

  const uaPubKey = await crypto.subtle.importKey(
    "raw",
    uaP256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // Workers' SubtleCrypto types name the peer key `$public` to avoid the `public` TS keyword;
  // workerd accepts both at runtime, so we use the spec-compliant `public` and cast for typing.
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPubKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    eph.privateKey,
    256,
  );
  const ecdhSecret = new Uint8Array(sharedBits);

  // RFC 8291: PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HKDF-Expand(PRK_key, key_info, 32)
  const prkKey = await hmacSha256(uaAuthSecret, ecdhSecret);
  const keyInfo = new Uint8Array(14 + 65 + 65);
  keyInfo.set(enc.encode("WebPush: info\0"), 0);
  keyInfo.set(uaP256dh, 14);
  keyInfo.set(asPubRaw, 14 + 65);
  const ikm = await hkdfExpandOneBlock(prkKey, keyInfo, 32);

  // RFC 8188 (aes128gcm content encoding)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpandOneBlock(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpandOneBlock(prk, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM", length: 128 }, false, ["encrypt"]);
  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext, 0);
  padded[plaintext.length] = 0x02;  // last-record delimiter (RFC 8188 §2)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // aes128gcm header: salt(16) | rs(4 BE) | idlen(1) | keyid | ciphertext
  const recordSize = 4096;
  const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  let o = 0;
  body.set(salt, o); o += 16;
  body[o++] = (recordSize >>> 24) & 0xff;
  body[o++] = (recordSize >>> 16) & 0xff;
  body[o++] = (recordSize >>> 8) & 0xff;
  body[o++] = recordSize & 0xff;
  body[o++] = 65;
  body.set(asPubRaw, o); o += 65;
  body.set(ciphertext, o);
  return body;
}

export async function sendPush(
  sub: PushSubscriptionLike,
  payload: unknown,
  vapid: VapidKeys,
  ttlSeconds: number = 60,
): Promise<SendPushResult> {
  const audience = new URL(sub.endpoint).origin;
  const jwt = await signVapidJwt(audience, vapid);

  const body = await encryptAes128Gcm(
    enc.encode(JSON.stringify(payload)),
    b64uDecode(sub.keys.p256dh),
    b64uDecode(sub.keys.auth),
  );

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttlSeconds),
    },
    body,
  });

  return {
    ok: res.ok,
    status: res.status,
    expired: res.status === 404 || res.status === 410,
  };
}
