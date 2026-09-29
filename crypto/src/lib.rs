//! A thin binding over vodozemac for Meadow's end-to-end encryption (SPEC §8).
//!
//! It exposes only what §8 uses: an Olm account with a fallback key, Olm
//! sessions, and Megolm outbound and inbound group sessions, all in the
//! version 1 session configuration (§8.1). It adds no cryptography of its own:
//! every operation is a direct call into vodozemac. Keys, messages, and session
//! keys cross the boundary as unpadded standard base64 strings, as vodozemac
//! encodes them; state crosses it as vodozemac pickles encrypted with a
//! caller-supplied 32-byte key.

use vodozemac::megolm::{self, ExportedSessionKey, MegolmMessage, SessionKey};
use vodozemac::olm::{self, OlmMessage};
use vodozemac::{Curve25519PublicKey, base64_decode, base64_encode};
use wasm_bindgen::prelude::*;

const OLM: olm::SessionConfig = olm::SessionConfig::version_1();
const MEGOLM: megolm::SessionConfig = megolm::SessionConfig::version_1();

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn pickle_key(key: &[u8]) -> Result<[u8; 32], JsError> {
    key.try_into().map_err(|_| JsError::new("a pickle key is 32 bytes"))
}

fn curve_key(b64: &str) -> Result<Curve25519PublicKey, JsError> {
    Curve25519PublicKey::from_base64(b64).map_err(err)
}

/// An agent's Olm account: its Curve25519 identity key and its fallback key (§8.2).
#[wasm_bindgen]
pub struct Account(olm::Account);

#[wasm_bindgen]
impl Account {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Account {
        Account(olm::Account::new())
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Result<Account, JsError> {
        let p = olm::AccountPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(err)?;
        Ok(Account(olm::Account::from_pickle(p)))
    }

    pub fn pickle(&self, key: &[u8]) -> Result<String, JsError> {
        Ok(self.0.pickle().encrypt(&pickle_key(key)?))
    }

    /// The Curve25519 identity key: `keys.curve25519` in the agent's bundle (§3.3).
    #[wasm_bindgen(getter, js_name = curve25519Key)]
    pub fn curve25519_key(&self) -> String {
        self.0.curve25519_key().to_base64()
    }

    /// Makes a new fallback key and returns its public half: `keys.fallback` (§3.3).
    /// The account keeps the previous one until the next rotation (§8.2).
    #[wasm_bindgen(js_name = generateFallbackKey)]
    pub fn generate_fallback_key(&mut self) -> Result<String, JsError> {
        self.0.generate_fallback_key();
        let keys = self.0.fallback_key();
        let key = keys.values().next().ok_or_else(|| JsError::new("no fallback key"))?;
        let b64 = key.to_base64();
        self.0.mark_keys_as_published();
        Ok(b64)
    }

    /// An outbound Olm session to a peer, from its published keys (§8.3).
    #[wasm_bindgen(js_name = createOutboundSession)]
    pub fn create_outbound_session(&self, identity_key: &str, fallback_key: &str) -> Result<Session, JsError> {
        let s = self
            .0
            .create_outbound_session(OLM, curve_key(identity_key)?, curve_key(fallback_key)?)
            .map_err(err)?;
        Ok(Session(s))
    }

    /// An inbound Olm session from a peer's pre-key message (type 0). Fails if
    /// the message does not name `their_identity_key`, the key in the sender's
    /// verified chain (§8.3).
    #[wasm_bindgen(js_name = createInboundSession)]
    pub fn create_inbound_session(&mut self, their_identity_key: &str, body: &str) -> Result<InboundSession, JsError> {
        let bytes = base64_decode(body).map_err(err)?;
        let message = match OlmMessage::from_parts(0, &bytes).map_err(err)? {
            OlmMessage::PreKey(m) => m,
            OlmMessage::Normal(_) => return Err(JsError::new("not a pre-key message")),
        };
        let r = self
            .0
            .create_inbound_session(OLM, curve_key(their_identity_key)?, &message)
            .map_err(err)?;
        let plaintext = String::from_utf8(r.plaintext).map_err(err)?;
        Ok(InboundSession { session: Some(Session(r.session)), plaintext })
    }
}

/// The result of `createInboundSession`: the new session and the first plaintext.
#[wasm_bindgen]
pub struct InboundSession {
    session: Option<Session>,
    plaintext: String,
}

#[wasm_bindgen]
impl InboundSession {
    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> String {
        self.plaintext.clone()
    }

    /// Takes the session out; a second call fails.
    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(&mut self) -> Result<Session, JsError> {
        self.session.take().ok_or_else(|| JsError::new("session already taken"))
    }
}

/// A pairwise Olm session with one peer (§8.3).
#[wasm_bindgen]
pub struct Session(olm::Session);

/// An Olm message: `type` 0 (pre-key) or 1 (normal), and its base64 `body` (§8.5).
#[wasm_bindgen]
pub struct OlmCiphertext {
    #[wasm_bindgen(js_name = type)]
    pub message_type: u32,
    body: String,
}

#[wasm_bindgen]
impl OlmCiphertext {
    #[wasm_bindgen(getter)]
    pub fn body(&self) -> String {
        self.body.clone()
    }
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Result<Session, JsError> {
        let p = olm::SessionPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(err)?;
        Ok(Session(olm::Session::from_pickle(p)))
    }

    pub fn pickle(&self, key: &[u8]) -> Result<String, JsError> {
        Ok(self.0.pickle().encrypt(&pickle_key(key)?))
    }

    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    #[wasm_bindgen(getter, js_name = hasReceivedMessage)]
    pub fn has_received_message(&self) -> bool {
        self.0.has_received_message()
    }

    pub fn encrypt(&mut self, plaintext: &str) -> Result<OlmCiphertext, JsError> {
        let (t, bytes) = self.0.encrypt(plaintext).map_err(err)?.to_parts();
        Ok(OlmCiphertext { message_type: t as u32, body: base64_encode(bytes) })
    }

    pub fn decrypt(&mut self, message_type: u32, body: &str) -> Result<String, JsError> {
        let bytes = base64_decode(body).map_err(err)?;
        let message = OlmMessage::from_parts(message_type as usize, &bytes).map_err(err)?;
        String::from_utf8(self.0.decrypt(&message).map_err(err)?).map_err(err)
    }
}

/// A member's outbound Megolm session in one room (§8.4).
#[wasm_bindgen]
pub struct GroupSession(megolm::GroupSession);

#[wasm_bindgen]
impl GroupSession {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> GroupSession {
        GroupSession(megolm::GroupSession::new(MEGOLM))
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Result<GroupSession, JsError> {
        let p = megolm::GroupSessionPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(err)?;
        Ok(GroupSession(megolm::GroupSession::from_pickle(p)))
    }

    pub fn pickle(&self, key: &[u8]) -> Result<String, JsError> {
        Ok(self.0.pickle().encrypt(&pickle_key(key)?))
    }

    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    /// The index the next message will have.
    #[wasm_bindgen(getter, js_name = messageIndex)]
    pub fn message_index(&self) -> u32 {
        self.0.message_index()
    }

    /// The session key at the current index: `form: "session"` in a share (§8.5).
    #[wasm_bindgen(getter, js_name = sessionKey)]
    pub fn session_key(&self) -> String {
        self.0.session_key().to_base64()
    }

    /// The owner's own inbound copy, kept so it can share again from an earlier index (§8.4, §8.6).
    /// The copy starts at the session's current index, so take it when the session is
    /// created, before the first `encrypt`: a copy taken later cannot export earlier indexes.
    #[wasm_bindgen(js_name = inboundCopy)]
    pub fn inbound_copy(&self) -> InboundGroupSession {
        InboundGroupSession(megolm::InboundGroupSession::from(&self.0))
    }

    pub fn encrypt(&mut self, plaintext: &str) -> String {
        self.0.encrypt(plaintext).to_base64()
    }
}

/// The message index a Megolm message claims, without decrypting it, so a
/// receiver can tell a message before its session's first known index
/// (`missing_key`) from one that fails to decrypt (`undecryptable`, §8.7).
#[wasm_bindgen(js_name = megolmMessageIndex)]
pub fn megolm_message_index(message: &str) -> Result<u32, JsError> {
    Ok(MegolmMessage::from_base64(message).map_err(err)?.message_index())
}

/// A received Megolm session: decrypts, never encrypts (§8.1).
#[wasm_bindgen]
pub struct InboundGroupSession(megolm::InboundGroupSession);

/// A decrypted Megolm message and its index.
#[wasm_bindgen]
pub struct Decrypted {
    plaintext: String,
    #[wasm_bindgen(js_name = messageIndex)]
    pub message_index: u32,
}

#[wasm_bindgen]
impl Decrypted {
    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> String {
        self.plaintext.clone()
    }
}

#[wasm_bindgen]
impl InboundGroupSession {
    /// From a shared session key, `form: "session"` (§8.5).
    #[wasm_bindgen(constructor)]
    pub fn new(session_key: &str) -> Result<InboundGroupSession, JsError> {
        let key = SessionKey::from_base64(session_key).map_err(err)?;
        Ok(InboundGroupSession(megolm::InboundGroupSession::new(&key, MEGOLM)))
    }

    /// From an exported session key, `form: "export"` (§8.6).
    pub fn import(exported: &str) -> Result<InboundGroupSession, JsError> {
        let key = ExportedSessionKey::from_base64(exported).map_err(err)?;
        Ok(InboundGroupSession(megolm::InboundGroupSession::import(&key, MEGOLM)))
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Result<InboundGroupSession, JsError> {
        let p = megolm::InboundGroupSessionPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(err)?;
        Ok(InboundGroupSession(megolm::InboundGroupSession::from_pickle(p)))
    }

    pub fn pickle(&self, key: &[u8]) -> Result<String, JsError> {
        Ok(self.0.pickle().encrypt(&pickle_key(key)?))
    }

    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    #[wasm_bindgen(getter, js_name = firstKnownIndex)]
    pub fn first_known_index(&self) -> u32 {
        self.0.first_known_index()
    }

    /// The session exported at `index`, for `form: "export"` (§8.6); undefined
    /// if `index` is before the first index this copy knows.
    #[wasm_bindgen(js_name = exportAt)]
    pub fn export_at(&mut self, index: u32) -> Option<String> {
        self.0.export_at(index).map(|k| k.to_base64())
    }

    pub fn decrypt(&mut self, message: &str) -> Result<Decrypted, JsError> {
        let m = MegolmMessage::from_base64(message).map_err(err)?;
        let d = self.0.decrypt(&m).map_err(err)?;
        Ok(Decrypted { plaintext: String::from_utf8(d.plaintext).map_err(err)?, message_index: d.message_index })
    }
}
