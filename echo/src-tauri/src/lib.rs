#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod hide_sharing;

use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::JsonValue;
use tauri_plugin_store::{Store, StoreBuilder};

struct AppState {
    token: Mutex<Option<String>>,
}

#[tauri::command]
fn save_server_url(store: tauri::State<Arc<Store<tauri::Wry>>>, url: String) -> Result<(), String> {
    store.set("server_url", JsonValue::String(url));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_server_url(store: tauri::State<Arc<Store<tauri::Wry>>>) -> Result<String, String> {
    store
        .get("server_url")
        .and_then(|v| match v {
            JsonValue::String(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| "No server URL set".to_string())
}

#[tauri::command]
fn save_token(
    state: tauri::State<AppState>,
    store: tauri::State<Arc<Store<tauri::Wry>>>,
    token: String,
) -> Result<(), String> {
    *state.token.lock().map_err(|e| e.to_string())? = Some(token.clone());
    store.set("auth_token", JsonValue::String(token));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token(
    state: tauri::State<AppState>,
    store: tauri::State<Arc<Store<tauri::Wry>>>,
) -> Result<String, String> {
    if let Ok(guard) = state.token.lock() {
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
    }
    if let Some(t) = store.get("auth_token").and_then(|v| match v {
        JsonValue::String(s) => Some(s.clone()),
        _ => None,
    }) {
        if let Ok(mut guard) = state.token.lock() {
            *guard = Some(t.clone());
        }
        return Ok(t);
    }
    Err("No token".to_string())
}

#[tauri::command]
fn show_notification(app: tauri::AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn hide_screen_sharing_indicator(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    return hide_sharing::run(app);
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let store = StoreBuilder::new(app, "store.json").build()?;
            app.manage(store);
            Ok(())
        })
        .manage(AppState {
            token: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            save_server_url,
            get_server_url,
            save_token,
            get_token,
            show_notification,
            hide_screen_sharing_indicator,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Echo");
}
