//! Verify personal_sign (EIP-191) signatures for document hashes.

use alloy_primitives::{Address, Signature};
use anyhow::anyhow;

/// Verifies a personal_sign signature over a message and returns the recovered address.
/// The message should be exactly what was signed (e.g. hex string of document hash).
/// For a 32-byte hash, the frontend typically signs the hex string "0x" + 64 hex chars.
pub fn recover_signer(message: &[u8], signature_hex: &str) -> anyhow::Result<Address> {
    let sig_bytes = hex::decode(signature_hex.trim_start_matches("0x"))
        .map_err(|e| anyhow!("Invalid signature hex: {}", e))?;
    let sig = Signature::from_raw(&sig_bytes)
        .map_err(|e| anyhow!("Invalid signature format: {}", e))?;
    sig.recover_address_from_msg(message)
        .map_err(|e| anyhow!("Recovery failed: {}", e))
}

/// Normalize an address string for comparison (lowercase, 0x prefix).
pub fn normalize_address(addr: &str) -> String {
    let s = addr.trim_start_matches("0x");
    format!("0x{}", s.to_lowercase())
}
