# TobiiEyeTrainer 2026.10.16

本版調整各測驗的 Accuracy 計分階段，新增 Saccade 的 Time To First Fixation（TFF），並改善 WebGazer 初始化、取樣時間與多螢幕顯示。

- **Smooth Pursuit**：圓球從中心移至邊緣後，連續移動回中心；去程與回程均計入 Accuracy，中央十字準備時間排除。完成一次往返才計為一個目標。
- **Fixation**：Accuracy 只計算圓球抵達邊緣後的停留時間。中央十字與移動途中排除，移動軌跡及視線仍保留於原始 CSV／JSON。
- **Saccade TFF**：每次目標出現後，先偵測眼動，再找首次穩定注視，不要求命中目標。注視判定採角速度不超過 30°/秒、持續至少 100 ms，且至少 3 筆有效樣本。TFF 從目標出現算到注視開始，不包含等待確認的時間，也不受 Accuracy 的 200 ms 容許窗限制。結果顯示平均 TFF，CSV／JSON 保留逐目標數值、偵測狀態與成功偵測數；未偵測者標示 N/A，不納入平均。
- **誤差容許值**：WebGazer 加入 2° 容許值，Tobii 維持 1°；實際命中閾值採「設定值加容許值」與「同來源驗證閾值」的較大者，避免重複加算驗證誤差。
- **WebGazer 取樣與啟動**：以推論開始時間對應刺激歷史畫面，記錄推論開始至回呼的延遲；jsPsych 使用單一預測串流。FaceMesh／BlazeFace 模型與權重隨 EXE 打包，減少遠端下載等待，並改善相機啟動提示及資源釋放。
- **多螢幕顯示**：使用 PerMonitorV2 DPI 支援、固定 WebView 內容縮放，並依視窗所在螢幕取得全螢幕範圍，改善筆電與外接螢幕使用不同縮放比例時的顯示問題。
- **原始資料與報表**：補齊 WebGazer 原始樣本、缺失時間及拒收時間戳記錄。CSV 由 19 欄擴充至 25 欄，新增 `target_number`、`accuracy_eligible`、`accuracy_delta_t_ms`、`gaze_velocity_deg_s`、`is_fixation`、`tff_ms`。

資料分析時，`is_within_threshold` 表示原始空間命中，包括排除計分的階段；重建 Accuracy 請使用 `accuracy_delta_t_ms` 作為時間權重，不要以命中樣本比例取代。

驗證：48 項自動測試通過；瀏覽器畫面已檢查 1920×1080／100%、1280×854／225%、2560×1440／100% 三組尺寸與像素倍率。這些檢查不代表已驗證所有實體螢幕及鏡頭組合，WebGazer 雜訊仍可能影響 TFF 偵測率。

下載附件 `TobiiEyeTrainer.exe`，於 Windows x64 直接執行；需要 Microsoft Edge WebView2 Runtime。
