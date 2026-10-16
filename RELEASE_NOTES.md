- **Smooth Pursuit**：圓球移至邊緣後返回中心；Accuracy 計入去、回程，排除中央十字。
- **Fixation**：Accuracy 僅計邊緣停留，移動軌跡仍保留於原始資料。
- **Saccade**：新增 TFF，從目標出現量測至眼動後首次穩定注視，不要求命中目標。
- **WebGazer**：加入 2° 誤差容許值，改善啟動流程與取樣時間對齊。
- 修正不同螢幕縮放比例下的顯示問題。

CSV 擴充為 25 欄。`is_within_threshold` 僅表示空間命中；重算 Accuracy 請使用 `accuracy_delta_t_ms` 作時間權重。

下載附件 `OcuTrain_1.1.0_x64-setup.exe`（Windows x64 免安裝版；需 Microsoft Edge WebView2 Runtime）。
