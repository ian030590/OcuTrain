- 修正 Hit Distance Threshold 修改後未儲存、訓練仍使用預設門檻的問題，適用全部模組。
- 門檻滑桿與數字欄共用依螢幕對角視角計算的上限，移除原滑桿 360 arcmin 的固定限制；刺激大小滑桿與數字欄範圍也已同步。
- Saccade 新增 **Horizontal／Vertical Target Span**，設定左右／上下兩側目標中心之間的總視角；刺激位置依實體螢幕尺寸及觀看距離換算，並檢查目標半徑，避免超出畫面。
- CSV 新增水平／垂直目標範圍，方便核對訓練設定。Hit Distance Threshold 僅控制命中容許誤差，不改變刺激位置。

Windows x64 免安裝版：`OcuTrain_1.2.1_x64-portable.exe`（需 Microsoft Edge WebView2 Runtime）。

請關閉舊程式後執行新版本。未曾設定 Saccade 目標範圍時，沿用原九宮格各格中央的位置。
