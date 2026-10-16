- Windows 宿主改為 **Tauri 2 + Rust**，沿用系統 WebView2，移除 .NET 執行環境。
- 保留 Tobii 原生串流、SDK 時鐘對齊、WebGazer 本機模型與 Accuracy／TFF 計算。
- 依目前螢幕與視窗實體座標處理 DPI、全螢幕及眼動座標。
- CSV／JSON 由 Rust 儲存至執行檔旁的 `Data/`，存檔失敗會顯示錯誤。

Windows x64 免安裝版：`OcuTrain_1.2.0_x64-portable.exe`（需 Microsoft Edge WebView2 Runtime）。

從 v1.1.0 升級後，請重新設定螢幕尺寸、觀看距離與校正。
