#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod storage;
mod tobii;

use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};
use tobii::Tracker;

#[tauri::command]
async fn get_status(
    window: WebviewWindow,
    tracker: State<'_, Arc<Tracker>>,
) -> Result<tobii::Status, String> {
    tracker.refresh_geometry(&window);
    tracker
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Clock {
    system_timestamp_microseconds: i64,
}

#[tauri::command]
async fn get_clock(tracker: State<'_, Arc<Tracker>>) -> Result<Clock, String> {
    let tracker = Arc::clone(tracker.inner());
    let timestamp = tauri::async_runtime::spawn_blocking(move || tracker.clock())
        .await
        .map_err(|e| e.to_string())??;
    Ok(Clock {
        system_timestamp_microseconds: timestamp,
    })
}

#[tauri::command]
async fn save_document(filename: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::save_document(&storage::data_dir()?, &filename, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_data_folder() -> Result<(), String> {
    let directory = storage::data_dir()?;
    std::process::Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_fullscreen(
    window: WebviewWindow,
    fullscreen: bool,
    tracker: State<'_, Arc<Tracker>>,
) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|e| e.to_string())?;
    tracker.refresh_geometry(&window);
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .on_permission_request(|webview, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            let local = webview
                .url()
                .is_ok_and(|url| url.host_str() == Some("tauri.localhost"));
            if webview.label() == "main" && local && matches!(kind, PermissionKind::Camera) {
                PermissionResponse::Allow
            } else {
                PermissionResponse::Default
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_clock,
            save_document,
            open_data_folder,
            set_fullscreen,
            analysis::open_analysis,
            analysis::list_analysis_files,
            analysis::read_analysis_file,
            analysis::save_analysis_report
        ])
        .setup(|app| {
            app.manage(Tracker::start(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let (Some(tracker), Some(webview)) = (
                    window.try_state::<Arc<Tracker>>(),
                    window.app_handle().get_webview_window(window.label()),
                ) {
                    tracker.refresh_geometry(&webview);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start OcuTrain");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Arc<Tracker>>().stop();
        }
    });
}
