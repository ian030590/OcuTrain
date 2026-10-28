use std::{fs, io::Read, path::{Component, Path, PathBuf}};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct AnalysisFile {
    name: String,
    size: u64,
}

fn supported(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("csv") || s.eq_ignore_ascii_case("json"))
}

fn input_path(directory: &Path, filename: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(filename).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some()
        || filename.contains(['/', '\\', ':']) || !supported(Path::new(filename))
    {
        return Err("Expected a CSV or JSON filename in Data".into());
    }
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(filename).canonicalize().map_err(|e| e.to_string())?;
    if path.parent() != Some(root.as_path()) || !path.is_file() {
        return Err("File is outside the Data directory".into());
    }
    Ok(path)
}

fn list_files(directory: &Path) -> Result<Vec<AnalysisFile>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() && supported(&entry.path()) {
            files.push(AnalysisFile { name: entry.file_name().to_string_lossy().into_owned(),
                size: entry.metadata().map_err(|e| e.to_string())?.len() });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn read_file(directory: &Path, filename: &str) -> Result<String, String> {
    let file = fs::File::open(input_path(directory, filename)?).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("File exceeds the 64 MiB analysis limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("File exceeds the 64 MiB analysis limit".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

fn require_analysis(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "analysis" { Ok(()) } else { Err("Analysis window required".into()) }
}

#[tauri::command]
pub async fn open_analysis(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("analysis") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "analysis", WebviewUrl::App("analysis/index.html".into()))
        .title("OcuTrain | Analysis")
        .inner_size(1280.0, 860.0)
        .min_inner_size(800.0, 600.0)
        .use_https_scheme(true)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_analysis_files(window: WebviewWindow) -> Result<Vec<AnalysisFile>, String> {
    require_analysis(&window)?;
    tauri::async_runtime::spawn_blocking(|| list_files(&crate::storage::data_dir()?))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_analysis_file(window: WebviewWindow, filename: String) -> Result<String, String> {
    require_analysis(&window)?;
    tauri::async_runtime::spawn_blocking(move || read_file(&crate::storage::data_dir()?, &filename))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_analysis_report(window: WebviewWindow, filename: String, content: String) -> Result<String, String> {
    require_analysis(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = crate::storage::data_dir()?.join("Analysis");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        crate::storage::save_document(&directory, &filename, &content)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_reads_only_named_data_files_and_ignores_report_directories() {
        let directory = std::env::temp_dir().join(format!("ocutrain-analysis-{}", std::process::id()));
        fs::create_dir_all(directory.join("Analysis")).unwrap();
        fs::write(directory.join("sample.csv"), "\u{feff}sample,1").unwrap();
        fs::write(directory.join("sample.JSON"), "{}").unwrap();
        fs::write(directory.join("ignored.txt"), "ignored").unwrap();
        let files = list_files(&directory).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(read_file(&directory, "sample.csv").unwrap(), "\u{feff}sample,1");
        for filename in ["../sample.csv", "..\\sample.csv", "Analysis/sample.csv", "C:sample.csv", "ignored.txt", ""] {
            assert!(read_file(&directory, filename).is_err(), "{filename}");
        }
        for filename in ["sample.csv", "sample.JSON", "ignored.txt"] { fs::remove_file(directory.join(filename)).unwrap(); }
        fs::remove_dir(directory.join("Analysis")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn analysis_rejects_oversized_and_non_utf8_files() {
        let directory = std::env::temp_dir().join(format!("ocutrain-analysis-limits-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::File::create(directory.join("large.csv")).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        fs::write(directory.join("invalid.csv"), [0xff, 0xfe]).unwrap();
        assert!(read_file(&directory, "large.csv").unwrap_err().contains("64 MiB"));
        assert!(read_file(&directory, "invalid.csv").unwrap_err().contains("UTF-8"));
        fs::remove_file(directory.join("large.csv")).unwrap();
        fs::remove_file(directory.join("invalid.csv")).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
