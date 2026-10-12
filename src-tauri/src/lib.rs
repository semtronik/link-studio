mod app_logger;
mod commands;
mod firmware_manager;
mod frame_store;

mod lora_protocol;
mod port_scanner;
mod serial_manager;

pub use app_logger::{log_debug, log_error, log_info, log_warn};

use port_scanner::PortScanner;
use serial_manager::SerialManager;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let serial_state = Arc::new(Mutex::new(SerialManager::new()));
    let scanner = Arc::new(PortScanner::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(serial_state.clone())
        .manage(scanner.clone())
        .setup({
            let serial_state = serial_state.clone();
            let scanner = scanner.clone();
            move |app| {
                app_logger::init(&app.handle());
                scanner.spawn_loop(app.handle().clone(), serial_state);
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_current_ports,
            commands::set_scan_pace,
            commands::refresh_ports_now,
            commands::serial_connect,
            commands::serial_disconnect,
            commands::send_command,
            commands::apply_config,
            commands::get_config,
            commands::get_frames,
            commands::get_stats,
            commands::clear_frames,
            commands::load_capture,
            commands::get_valid_params,
            commands::get_device_version,
            commands::sync_time,
            commands::flash_firmware,
            commands::get_events,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start the application");
}
