use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn data_dir() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable
        .parent()
        .ok_or("Executable directory unavailable")?
        .join("Data");
    fs::create_dir_all(&directory)
        .map_err(|e| format!("Cannot create {}: {e}", directory.display()))?;
    Ok(directory)
}

pub fn save_document(directory: &Path, filename: &str, content: &str) -> Result<String, String> {
    // Accept a filename only: the webview cannot choose arbitrary filesystem paths.
    if filename.is_empty()
        || filename.len() > 240
        || filename.ends_with(['.', ' '])
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || !["csv", "json"].contains(&filename.rsplit('.').next().unwrap_or_default())
    {
        return Err("Expected a CSV or JSON filename without path components".into());
    }
    let stem = filename
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        return Err("Reserved Windows filename".into());
    }
    let destination = directory.join(filename);
    let mut bytes = Vec::with_capacity(content.len() + 3);
    if filename.ends_with(".csv") && !content.starts_with('\u{feff}') {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(content.as_bytes());
    fs::write(&destination, bytes)
        .map_err(|e| format!("Cannot save {}: {e}", destination.display()))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_windows_device_names() {
        for name in [
            "../escape.csv",
            "..\\escape.csv",
            "C:escape.csv",
            "CON.csv",
            "x.txt",
            "x.csv.",
            "",
            "x\n.csv",
        ] {
            assert!(
                save_document(Path::new("unused"), name, "").is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn csv_has_one_bom_and_json_round_trips() {
        let directory =
            std::env::temp_dir().join(format!("ocutrain-storage-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        save_document(&directory, "test.csv", "中文,1").unwrap();
        assert_eq!(
            fs::read(directory.join("test.csv")).unwrap(),
            "\u{feff}中文,1".as_bytes()
        );
        save_document(&directory, "test.csv", "\u{feff}中文,2").unwrap();
        assert_eq!(
            fs::read(directory.join("test.csv")).unwrap(),
            "\u{feff}中文,2".as_bytes()
        );
        save_document(&directory, "test.json", "{\"x\":1}").unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("test.json")).unwrap(),
            "{\"x\":1}"
        );
        fs::remove_file(directory.join("test.csv")).unwrap();
        fs::remove_file(directory.join("test.json")).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
