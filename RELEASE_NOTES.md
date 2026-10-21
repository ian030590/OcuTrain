- **Pursuit 與 Fixation 新增 Horizontal／Vertical Target Span (arcmin) 滑桿**，與 Saccade 使用相同的螢幕尺寸、觀看距離及目標半徑上限計算。
- Pursuit 會移至設定範圍的端點後返回中心；Fixation 會移至該端點後停留。水平、垂直範圍可獨立調整，移動時間依實際路徑與設定速度計算。
- 範圍隨各模組設定儲存，CSV／JSON 會保留水平與垂直 Target Span；調整目標大小或螢幕設定時，上限與超限數值同步更新。
- 舊資料未設定範圍時，Pursuit／Fixation 保留原本的畫面邊緣軌跡，Saccade 保留原九宮格位置；舊設定的 54 份輸出逐位元組一致。
- 66 項 JavaScript 測試通過，並完成三個模組的滑鼠、鍵盤、範圍儲存與窄螢幕操作驗證。

Windows x64 免安裝版：`OcuTrain_1.3.0_x64-portable.exe`（需 Microsoft Edge WebView2 Runtime）。

請關閉舊程式後執行新版本。未曾設定 Saccade 目標範圍時，沿用原九宮格各格中央的位置。實際 Tobii／攝影機量測尚未在本次發布中重新驗證。
