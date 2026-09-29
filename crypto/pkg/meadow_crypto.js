/* @ts-self-types="./meadow_crypto.d.ts" */

/**
 * An agent's Olm account: its Curve25519 identity key and its fallback key (§8.2).
 */
class Account {
    static __wrap(ptr) {
        const obj = Object.create(Account.prototype);
        obj.__wbg_ptr = ptr;
        AccountFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AccountFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_account_free(ptr, 0);
    }
    /**
     * An inbound Olm session from a peer's pre-key message (type 0). Fails if
     * the message does not name `their_identity_key`, the key in the sender's
     * verified chain (§8.3).
     * @param {string} their_identity_key
     * @param {string} body
     * @returns {InboundSession}
     */
    createInboundSession(their_identity_key, body) {
        const ptr0 = passStringToWasm0(their_identity_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(body, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.account_createInboundSession(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return InboundSession.__wrap(ret[0]);
    }
    /**
     * An outbound Olm session to a peer, from its published keys (§8.3).
     * @param {string} identity_key
     * @param {string} fallback_key
     * @returns {Session}
     */
    createOutboundSession(identity_key, fallback_key) {
        const ptr0 = passStringToWasm0(identity_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fallback_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.account_createOutboundSession(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Session.__wrap(ret[0]);
    }
    /**
     * The Curve25519 identity key: `keys.curve25519` in the agent's bundle (§3.3).
     * @returns {string}
     */
    get curve25519Key() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.account_curve25519Key(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} pickle
     * @param {Uint8Array} key
     * @returns {Account}
     */
    static fromPickle(pickle, key) {
        const ptr0 = passStringToWasm0(pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.account_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Account.__wrap(ret[0]);
    }
    /**
     * Makes a new fallback key and returns its public half: `keys.fallback` (§3.3).
     * The account keeps the previous one until the next rotation (§8.2).
     * @returns {string}
     */
    generateFallbackKey() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.account_generateFallbackKey(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    constructor() {
        const ret = wasm.account_new();
        this.__wbg_ptr = ret;
        AccountFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} key
     * @returns {string}
     */
    pickle(key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.account_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) Account.prototype[Symbol.dispose] = Account.prototype.free;
exports.Account = Account;

/**
 * A decrypted Megolm message and its index.
 */
class Decrypted {
    static __wrap(ptr) {
        const obj = Object.create(Decrypted.prototype);
        obj.__wbg_ptr = ptr;
        DecryptedFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecryptedFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decrypted_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get plaintext() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.decrypted_plaintext(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get messageIndex() {
        const ret = wasm.__wbg_get_decrypted_messageIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set messageIndex(arg0) {
        wasm.__wbg_set_decrypted_messageIndex(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Decrypted.prototype[Symbol.dispose] = Decrypted.prototype.free;
exports.Decrypted = Decrypted;

/**
 * A member's outbound Megolm session in one room (§8.4).
 */
class GroupSession {
    static __wrap(ptr) {
        const obj = Object.create(GroupSession.prototype);
        obj.__wbg_ptr = ptr;
        GroupSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GroupSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_groupsession_free(ptr, 0);
    }
    /**
     * @param {string} plaintext
     * @returns {string}
     */
    encrypt(plaintext) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.groupsession_encrypt(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} pickle
     * @param {Uint8Array} key
     * @returns {GroupSession}
     */
    static fromPickle(pickle, key) {
        const ptr0 = passStringToWasm0(pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.groupsession_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return GroupSession.__wrap(ret[0]);
    }
    /**
     * The owner's own inbound copy, kept so it can share again from an earlier index (§8.4, §8.6).
     * The copy starts at the session's current index, so take it when the session is
     * created, before the first `encrypt`: a copy taken later cannot export earlier indexes.
     * @returns {InboundGroupSession}
     */
    inboundCopy() {
        const ret = wasm.groupsession_inboundCopy(this.__wbg_ptr);
        return InboundGroupSession.__wrap(ret);
    }
    /**
     * The index the next message will have.
     * @returns {number}
     */
    get messageIndex() {
        const ret = wasm.groupsession_messageIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.groupsession_new();
        this.__wbg_ptr = ret;
        GroupSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} key
     * @returns {string}
     */
    pickle(key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.groupsession_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.groupsession_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The session key at the current index: `form: "session"` in a share (§8.5).
     * @returns {string}
     */
    get sessionKey() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.groupsession_sessionKey(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) GroupSession.prototype[Symbol.dispose] = GroupSession.prototype.free;
exports.GroupSession = GroupSession;

/**
 * A received Megolm session: decrypts, never encrypts (§8.1).
 */
class InboundGroupSession {
    static __wrap(ptr) {
        const obj = Object.create(InboundGroupSession.prototype);
        obj.__wbg_ptr = ptr;
        InboundGroupSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InboundGroupSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inboundgroupsession_free(ptr, 0);
    }
    /**
     * @param {string} message
     * @returns {Decrypted}
     */
    decrypt(message) {
        const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.inboundgroupsession_decrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Decrypted.__wrap(ret[0]);
    }
    /**
     * The session exported at `index`, for `form: "export"` (§8.6); undefined
     * if `index` is before the first index this copy knows.
     * @param {number} index
     * @returns {string | undefined}
     */
    exportAt(index) {
        const ret = wasm.inboundgroupsession_exportAt(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {number}
     */
    get firstKnownIndex() {
        const ret = wasm.inboundgroupsession_firstKnownIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {string} pickle
     * @param {Uint8Array} key
     * @returns {InboundGroupSession}
     */
    static fromPickle(pickle, key) {
        const ptr0 = passStringToWasm0(pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.inboundgroupsession_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return InboundGroupSession.__wrap(ret[0]);
    }
    /**
     * From an exported session key, `form: "export"` (§8.6).
     * @param {string} exported
     * @returns {InboundGroupSession}
     */
    static import(exported) {
        const ptr0 = passStringToWasm0(exported, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.inboundgroupsession_import(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return InboundGroupSession.__wrap(ret[0]);
    }
    /**
     * From a shared session key, `form: "session"` (§8.5).
     * @param {string} session_key
     */
    constructor(session_key) {
        const ptr0 = passStringToWasm0(session_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.inboundgroupsession_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        InboundGroupSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} key
     * @returns {string}
     */
    pickle(key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.inboundgroupsession_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.inboundgroupsession_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) InboundGroupSession.prototype[Symbol.dispose] = InboundGroupSession.prototype.free;
exports.InboundGroupSession = InboundGroupSession;

/**
 * The result of `createInboundSession`: the new session and the first plaintext.
 */
class InboundSession {
    static __wrap(ptr) {
        const obj = Object.create(InboundSession.prototype);
        obj.__wbg_ptr = ptr;
        InboundSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InboundSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inboundsession_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get plaintext() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.inboundsession_plaintext(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Takes the session out; a second call fails.
     * @returns {Session}
     */
    takeSession() {
        const ret = wasm.inboundsession_takeSession(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Session.__wrap(ret[0]);
    }
}
if (Symbol.dispose) InboundSession.prototype[Symbol.dispose] = InboundSession.prototype.free;
exports.InboundSession = InboundSession;

/**
 * An Olm message: `type` 0 (pre-key) or 1 (normal), and its base64 `body` (§8.5).
 */
class OlmCiphertext {
    static __wrap(ptr) {
        const obj = Object.create(OlmCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        OlmCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OlmCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_olmciphertext_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.__wbg_get_olmciphertext_type(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get body() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.olmciphertext_body(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} arg0
     */
    set type(arg0) {
        wasm.__wbg_set_olmciphertext_type(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) OlmCiphertext.prototype[Symbol.dispose] = OlmCiphertext.prototype.free;
exports.OlmCiphertext = OlmCiphertext;

/**
 * A pairwise Olm session with one peer (§8.3).
 */
class Session {
    static __wrap(ptr) {
        const obj = Object.create(Session.prototype);
        obj.__wbg_ptr = ptr;
        SessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_session_free(ptr, 0);
    }
    /**
     * @param {number} message_type
     * @param {string} body
     * @returns {string}
     */
    decrypt(message_type, body) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(body, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.session_decrypt(this.__wbg_ptr, message_type, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {string} plaintext
     * @returns {OlmCiphertext}
     */
    encrypt(plaintext) {
        const ptr0 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.session_encrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return OlmCiphertext.__wrap(ret[0]);
    }
    /**
     * @param {string} pickle
     * @param {Uint8Array} key
     * @returns {Session}
     */
    static fromPickle(pickle, key) {
        const ptr0 = passStringToWasm0(pickle, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.session_fromPickle(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Session.__wrap(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    get hasReceivedMessage() {
        const ret = wasm.session_hasReceivedMessage(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} key
     * @returns {string}
     */
    pickle(key) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.session_pickle(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get sessionId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.session_sessionId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) Session.prototype[Symbol.dispose] = Session.prototype.free;
exports.Session = Session;

/**
 * The message index a Megolm message claims, without decrypting it, so a
 * receiver can tell a message before its session's first known index
 * (`missing_key`) from one that fails to decrypt (`undecryptable`, §8.7).
 * @param {string} message
 * @returns {number}
 */
function megolmMessageIndex(message) {
    const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.megolmMessageIndex(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}
exports.megolmMessageIndex = megolmMessageIndex;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./meadow_crypto_bg.js": import0,
    };
}

const AccountFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_account_free(ptr, 1));
const DecryptedFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decrypted_free(ptr, 1));
const GroupSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_groupsession_free(ptr, 1));
const InboundGroupSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inboundgroupsession_free(ptr, 1));
const InboundSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inboundsession_free(ptr, 1));
const OlmCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_olmciphertext_free(ptr, 1));
const SessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_session_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/meadow_crypto_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
