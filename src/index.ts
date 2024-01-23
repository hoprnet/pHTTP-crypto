import * as hkdf from '@noble/hashes/hkdf';
import { Input, randomBytes, toBytes } from '@noble/hashes/utils';
import { blake2s } from '@noble/hashes/blake2s';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { secp256k1 } from '@noble/curves/secp256k1';

/// Represents a request-response session.
export type Session = {
    request?: Uint8Array;
    response?: Uint8Array;
    updatedTS: bigint;
    sharedPreSecret?: Uint8Array;
};

export enum ResState {
    Ok,
    Failed,
}

export type ResOk = { res: ResState.Ok; session: Session };
export type ResFailed = { res: ResState.Failed; error: string };

export type Result = ResOk | ResFailed;

/// pHTTP Crypto protocol version
export const pHTTP_CRYPTO_VERSION = 0x21;

/// Encoded public key size |W|
const PUBLIC_KEY_SIZE_ENCODED = 33;
/// Length of the counter |C|
const COUNTER_LEN = 8;

/// Length of the authentication tag |T|
const AUTH_TAG_LEN = 16;

const CIPHER_KEY_LEN = 32;
const CIPHER_IV_LEN = 12;

const BLAKE2S_LEN = 32;
const REQUEST_TAG = 'req';
const RESPONSE_TAG = 'resp';

function bigintToUint8BE(nr: bigint): Uint8Array {
    const result = new Uint8Array(8); // 8 bytes for a 64-bit BigInt

    for (let i = 7; i >= 0; i--) {
        result[i] = Number(nr & 0xffn); // Masking with 0xFFn to get the least significant byte
        nr = nr >> 8n; // Shift right by 8 bits to get the next byte
    }

    return result;
}

function uint8BEtoBigint(arr: Uint8Array): bigint {
    let result = 0n;

    for (let i = 0; i < arr.length; i++) {
        result = (result << 8n) | BigInt(arr[i]);
    }

    return result;
}

function wrapBlake2s256() {
    const blakeOpts = { dkLen: BLAKE2S_LEN };
    const tmp = blake2s.create(blakeOpts);

    const hashC = (msg: Input): Uint8Array =>
        blake2s.create(blakeOpts).update(toBytes(msg)).digest();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => blake2s.create(blakeOpts);
    return hashC;
}

function initializeCipher(
    sharedPreSecret: Uint8Array,
    counter: bigint,
    peerId: string,
    request: boolean,
    aad: string,
) {
    const startIndex = request ? 0 : 2;
    const saltTag = request ? REQUEST_TAG : RESPONSE_TAG;

    // Construct salt for the HKDF
    const textEnc = new TextEncoder();
    const salt = new Uint8Array(1 + peerId.length + saltTag.length);
    salt[0] = pHTTP_CRYPTO_VERSION;
    salt.set(textEnc.encode(peerId), 1);
    salt.set(textEnc.encode(saltTag), peerId.length + 1);

    // Generate key material for expansion
    const prk = hkdf.extract(wrapBlake2s256(), sharedPreSecret, salt);

    const cipherKeyLen = CIPHER_KEY_LEN;
    const idx = new Uint8Array(1);

    // First key material expansion for symmetric key
    idx[0] = startIndex;
    const key = hkdf.expand(wrapBlake2s256(), prk, idx, cipherKeyLen);

    // Second key material expansion for IV prefix
    idx[0] = startIndex + 1;
    const prefixLen = CIPHER_IV_LEN - COUNTER_LEN;
    const iv_prefix = hkdf.expand(wrapBlake2s256(), prk, idx, prefixLen);

    // Concatenate the prefix with the counter to form the IV
    const iv = new Uint8Array(CIPHER_IV_LEN);
    iv.set(iv_prefix, 0);
    iv.set(bigintToUint8BE(counter), prefixLen);

    // Initialize Chacha20 with Poly1305
    return chacha20poly1305(key, iv, textEnc.encode(aad));
}

/// Generates a random secp256k1 keypair
function generateEphemeralKey(randomFn: (len: number) => Uint8Array) {
    const privKey = randomFn(32);
    const pubKey = secp256k1.getPublicKey(privKey);
    if (pubKey.length !== PUBLIC_KEY_SIZE_ENCODED) {
        throw new Error('key size mismatch');
    }

    return { pubKey, privKey };
}

/// Called by the pHTTP client
/// Takes enveloped request data, the public key of the pHTTP Exit Node and Request counter for such
/// pHTTP Exit node and then encrypts and authenticates the data.
/// The encrypted data and new counter value to be persisted is returned in the resulting session.
export function boxRequest(
    {
        message,
        uuid,
        counterOffset,
        exitPeerId,
        exitPublicKey,
    }: {
        message: Uint8Array;
        uuid: string;
        counterOffset: number;
        exitPeerId: string;
        exitPublicKey: Uint8Array;
    },
    randomFn: (len: number) => Uint8Array = randomBytes,
): Result {
    if (exitPublicKey.length !== PUBLIC_KEY_SIZE_ENCODED) {
        return { res: ResState.Failed, error: 'incorrect public key size' };
    }

    let ephemeralKey;
    let sharedPreSecret;
    try {
        ephemeralKey = generateEphemeralKey(randomFn);
        sharedPreSecret = secp256k1.getSharedSecret(ephemeralKey.privKey, exitPublicKey).slice(1);
    } catch (err) {
        return { res: ResState.Failed, error: `ecdh failed ${err}` };
    }

    const newCounter = BigInt(Date.now() + 1 + counterOffset);

    let cipher;
    try {
        cipher = initializeCipher(sharedPreSecret, newCounter, exitPeerId, true, uuid);
    } catch (err) {
        return { res: ResState.Failed, error: `failed to initialize cipher: ${err}` };
    }

    let cipherText;
    try {
        cipherText = cipher.encrypt(message);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `failed to encrypt data: ${err}`,
        };
    }

    const counterBuf = bigintToUint8BE(newCounter);
    const versionBuf = new Uint8Array([pHTTP_CRYPTO_VERSION]);

    // V,W,C,R,T
    const result = new Uint8Array(
        versionBuf.length + ephemeralKey.pubKey.length + counterBuf.length + cipherText.length,
    );
    result.set(versionBuf, 0);
    result.set(ephemeralKey.pubKey, versionBuf.length);
    result.set(counterBuf, versionBuf.length + ephemeralKey.pubKey.length);
    result.set(cipherText, versionBuf.length + ephemeralKey.pubKey.length + counterBuf.length);

    return {
        res: ResState.Ok,
        session: {
            request: new Uint8Array(result),
            updatedTS: newCounter,
            sharedPreSecret,
        },
    };
}

/// Called by the pHTTP Exit Node
/// Takes enveloped encrypted data, the private key of the pHTTP Exit Node and Request counter for
/// pHTTP Client node associated with the request and then decrypts and verifies the data.
/// The decrypted data and new counter value to be persisted is returned in the resulting session.
/// Returns error and session if count verifcation failed so a response with the error message can still be boxed.
export function unboxRequest({
    message,
    uuid,
    exitPeerId,
    exitPrivateKey,
}: {
    message: Uint8Array;
    uuid: string;
    exitPeerId: string;
    exitPrivateKey: Uint8Array;
}): Result {
    if ((message[0] & 0x10) != (pHTTP_CRYPTO_VERSION & 0x10)) {
        return {
            res: ResState.Failed,
            error: 'unsupported protocol version',
        };
    }

    if (message.length <= 1 + PUBLIC_KEY_SIZE_ENCODED + COUNTER_LEN + AUTH_TAG_LEN) {
        return {
            res: ResState.Failed,
            error: 'invalid message size',
        };
    }

    if (!exitPrivateKey) {
        return {
            res: ResState.Failed,
            error: 'missing private key',
        };
    }

    let sharedPreSecret;
    try {
        const ephemeralPk = message.slice(1, PUBLIC_KEY_SIZE_ENCODED + 1);
        sharedPreSecret = secp256k1.getSharedSecret(exitPrivateKey, ephemeralPk).slice(1);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `ecdh failed: ${err}`,
        };
    }

    const counterArr = message.slice(
        1 + PUBLIC_KEY_SIZE_ENCODED,
        1 + PUBLIC_KEY_SIZE_ENCODED + COUNTER_LEN,
    );
    const counter = uint8BEtoBigint(counterArr);

    let cipher;
    try {
        cipher = initializeCipher(sharedPreSecret, counter, exitPeerId, true, uuid);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `failed to initialize cipher: ${err}`,
        };
    }

    let plaintext;
    try {
        plaintext = cipher.decrypt(message.slice(1 + PUBLIC_KEY_SIZE_ENCODED + COUNTER_LEN));
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `decryption failed: ${err}`,
        };
    }

    const session = {
        request: plaintext,
        updatedTS: counter,
        sharedPreSecret,
    };

    return {
        res: ResState.Ok,
        session,
    };
}

/// Called by the pHTTP Exit Node
/// Takes enveloped response data, the request session obtained by unboxRequest and Response counter for the associated
/// pHTTP Client node and then encrypts and authenticates the data.
/// The encrypted data and new counter value to be persisted is returned in the resulting session.
export function boxResponse(
    session: Session,
    { entryPeerId, uuid, message }: { entryPeerId: string; uuid: string; message: Uint8Array },
): Result {
    const sharedPreSecret = session.sharedPreSecret;
    if (!sharedPreSecret) {
        return {
            res: ResState.Failed,
            error: 'invalid session',
        };
    }

    const newCounter = BigInt(Date.now() + 1);

    let cipher;
    try {
        cipher = initializeCipher(sharedPreSecret, newCounter, entryPeerId, false, uuid);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `failed to initialize cipher: ${err}`,
        };
    }

    let cipherText;
    try {
        cipherText = cipher.encrypt(message);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `failed to encrypt data: ${err}`,
        };
    }

    const counterBuf = bigintToUint8BE(newCounter);

    // C,R,T
    const result = new Uint8Array(counterBuf.length + cipherText.length);
    result.set(counterBuf, 0);
    result.set(cipherText, counterBuf.length);
    session.response = result;
    session.updatedTS = newCounter;

    return {
        res: ResState.Ok,
        session,
    };
}

/// Called by the pHTTP Client Node
/// Takes enveloped encrypted data, the associated session returned by boxRequest and Request counter for
/// pHTTP Exit node associated with the response and then decrypts and verifies the data.
/// The decrypted data and new counter value to be persisted is returned in the resulting session.
export function unboxResponse(
    session: Session,
    { entryPeerId, uuid, message }: { entryPeerId: string; uuid: string; message: Uint8Array },
): Result {
    const sharedPreSecret = session.sharedPreSecret;
    if (!sharedPreSecret) {
        return {
            res: ResState.Failed,
            error: 'invalid session',
        };
    }

    if (message.length <= COUNTER_LEN + AUTH_TAG_LEN) {
        return {
            res: ResState.Failed,
            error: 'invalid message size',
        };
    }

    const counterArr = message.slice(0, COUNTER_LEN);
    const counter = uint8BEtoBigint(counterArr);

    let cipher;
    try {
        cipher = initializeCipher(sharedPreSecret, counter, entryPeerId, false, uuid);
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `failed to initialize cipher: ${err}`,
        };
    }

    let plaintext;
    try {
        plaintext = cipher.decrypt(message.slice(COUNTER_LEN));
    } catch (err) {
        return {
            res: ResState.Failed,
            error: `decryption failed: ${err}`,
        };
    }

    session.response = plaintext;
    session.updatedTS = counter;

    return {
        res: ResState.Ok,
        session,
    };
}

export function isOk(res: Result): res is ResOk {
    return res.res == ResState.Ok;
}

export function isError(res: Result): res is ResFailed {
    return res.res == ResState.Failed;
}
