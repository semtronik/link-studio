use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub fn compute_sha256(path: &PathBuf) -> Result<String, String> {
    let data =
        std::fs::read(path).map_err(|e| format!("File read failed: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}
