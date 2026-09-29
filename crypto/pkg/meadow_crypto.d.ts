/* tslint:disable */
/* eslint-disable */

/**
 * An agent's Olm account: its Curve25519 identity key and its fallback key (§8.2).
 */
export class Account {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * An inbound Olm session from a peer's pre-key message (type 0). Fails if
     * the message does not name `their_identity_key`, the key in the sender's
     * verified chain (§8.3).
     */
    createInboundSession(their_identity_key: string, body: string): InboundSession;
    /**
     * An outbound Olm session to a peer, from its published keys (§8.3).
     */
    createOutboundSession(identity_key: string, fallback_key: string): Session;
    static fromPickle(pickle: string, key: Uint8Array): Account;
    /**
     * Makes a new fallback key and returns its public half: `keys.fallback` (§3.3).
     * The account keeps the previous one until the next rotation (§8.2).
     */
    generateFallbackKey(): string;
    constructor();
    pickle(key: Uint8Array): string;
    /**
     * The Curve25519 identity key: `keys.curve25519` in the agent's bundle (§3.3).
     */
    readonly curve25519Key: string;
}

/**
 * A decrypted Megolm message and its index.
 */
export class Decrypted {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly plaintext: string;
    messageIndex: number;
}

/**
 * A member's outbound Megolm session in one room (§8.4).
 */
export class GroupSession {
    free(): void;
    [Symbol.dispose](): void;
    encrypt(plaintext: string): string;
    static fromPickle(pickle: string, key: Uint8Array): GroupSession;
    /**
     * The owner's own inbound copy, kept so it can share again from an earlier index (§8.4, §8.6).
     * The copy starts at the session's current index, so take it when the session is
     * created, before the first `encrypt`: a copy taken later cannot export earlier indexes.
     */
    inboundCopy(): InboundGroupSession;
    constructor();
    pickle(key: Uint8Array): string;
    /**
     * The index the next message will have.
     */
    readonly messageIndex: number;
    readonly sessionId: string;
    /**
     * The session key at the current index: `form: "session"` in a share (§8.5).
     */
    readonly sessionKey: string;
}

/**
 * A received Megolm session: decrypts, never encrypts (§8.1).
 */
export class InboundGroupSession {
    free(): void;
    [Symbol.dispose](): void;
    decrypt(message: string): Decrypted;
    /**
     * The session exported at `index`, for `form: "export"` (§8.6); undefined
     * if `index` is before the first index this copy knows.
     */
    exportAt(index: number): string | undefined;
    static fromPickle(pickle: string, key: Uint8Array): InboundGroupSession;
    /**
     * From an exported session key, `form: "export"` (§8.6).
     */
    static import(exported: string): InboundGroupSession;
    /**
     * From a shared session key, `form: "session"` (§8.5).
     */
    constructor(session_key: string);
    pickle(key: Uint8Array): string;
    readonly firstKnownIndex: number;
    readonly sessionId: string;
}

/**
 * The result of `createInboundSession`: the new session and the first plaintext.
 */
export class InboundSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Takes the session out; a second call fails.
     */
    takeSession(): Session;
    readonly plaintext: string;
}

/**
 * An Olm message: `type` 0 (pre-key) or 1 (normal), and its base64 `body` (§8.5).
 */
export class OlmCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    type: number;
    readonly body: string;
}

/**
 * A pairwise Olm session with one peer (§8.3).
 */
export class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(message_type: number, body: string): string;
    encrypt(plaintext: string): OlmCiphertext;
    static fromPickle(pickle: string, key: Uint8Array): Session;
    pickle(key: Uint8Array): string;
    readonly hasReceivedMessage: boolean;
    readonly sessionId: string;
}

/**
 * The message index a Megolm message claims, without decrypting it, so a
 * receiver can tell a message before its session's first known index
 * (`missing_key`) from one that fails to decrypt (`undecryptable`, §8.7).
 */
export function megolmMessageIndex(message: string): number;
