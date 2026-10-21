- Saccade 的 **Horizontal／Vertical Target Span (arcmin)** 改為滑桿，即時顯示目前數值與可用上限。
- 滑桿上限依輸入的螢幕實體長寬、觀看距離及目標大小計算，預留目標半徑；目標變大或重新設定螢幕時，超出新上限的數值會自動調整。
- 修正鍵盤焦點、滑桿標籤、刺激與方向按鈕的無障礙選取狀態，擴大操作區域，改善窄螢幕文字裁切。
- 保留既有設定、計分及 CSV／JSON 資料行為：58 項 JavaScript 測試通過；30 組輸入產生的 54 份輸出與修改前逐位元組一致。

Windows x64 免安裝版：`OcuTrain_1.2.2_x64-portable.exe`（需 Microsoft Edge WebView2 Runtime）。

請關閉舊程式後執行新版本。未曾設定 Saccade 目標範圍時，沿用原九宮格各格中央的位置。實際 Tobii／攝影機量測尚未在本次發布中重新驗證。
