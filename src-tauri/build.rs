fn main() {
    // Charger .env si present (dev local / build local)
    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                // Injecter dans l'environnement de compilation
                // pour que env!() fonctionne dans le code source
                std::env::set_var(key, value);
                println!("cargo:rustc-env={}={}", key, value);
            }
        }
        println!("cargo:rerun-if-changed=.env");
    }

    tauri_build::build()
}
