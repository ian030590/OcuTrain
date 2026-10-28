# OcuTrain

以 Tobii Eye Tracker 5 或 WebGazer 進行眼動訓練與記錄的 Windows 桌面程式，桌面宿主使用 **Tauri 2、Rust 與系統 WebView2**。提供 VOR、Smooth Pursuit、Fixation 與 Saccade 四種模組，使用實體螢幕尺寸與觀看距離換算視角，並以來源時間戳對應刺激畫面。

[下載最新版](https://github.com/ian030590/OcuTrain/releases/latest) · [版本更新說明](RELEASE_NOTES.md) · [AGPL-3.0 授權](LICENSE)

## 系統需求

- Windows x64 與 Microsoft Edge WebView2 Runtime。
- Tobii 模式：Tobii Eye Tracker 5，並先在 Tobii Experience 完成硬體校正。
- WebGazer 模式：可用的攝影機與相機權限。FaceMesh／BlazeFace 模型及權重已隨執行檔打包。
- 也可選擇 Off 執行刺激流程；未追蹤時沒有 gaze Accuracy 或 TFF 數值。

## 開始使用

1. 使用 `OcuTrain_<版本>_x64-portable.exe`（免安裝版），放在可寫入的資料夾後執行。Tauri 版將網頁與模型內嵌於執行檔；Tobii DLL 首次啟動時快取於使用者的應用程式資料夾。已發布版本見 [Releases](https://github.com/ian030590/OcuTrain/releases)。
2. 將視窗移至實際測試的螢幕。在 **Distance Setting** 輸入該螢幕的實體寬度、高度及觀看距離。Windows 縮放比例由程式處理，實體尺寸仍需正確設定。
3. 選擇 Tobii、WebGazer 或 Off。WebGazer 先完成相機定位與九點校正，再依畫面進行五點驗證。
4. 選擇模組、方向、刺激大小與時間等參數後開始。Evaluation 使用固定序列；Predictable 與 Random 依設定總時間結束。
5. 測驗以全螢幕執行，按 **Esc** 可中止。完成後可查看結果、開啟資料夾，或匯出 JSON／CSV。

每位受試者每天第一次，以及跨模組累計第 10、20、30…次正常完成練習後，會出現八方向複視問卷。同一次符合兩個條件時只填一次，中途停止不計次。請在各方向標記開始出現複視的位置，沒有複視則勾選「× 無複視」；八方向填完後才能送出。次數與最近問卷依受試者 ID 保存在本機，重新開啟程式仍會保留。

複視圖會沿用訓練的全螢幕，八個方向延伸至畫面邊緣。從中心沿方向線拖曳即可連續尋找起點，也可選擇方向後使用滑桿或鍵盤微調；操作列可隱藏，拖曳時會自動讓開畫面。按「檢查八方向答案」可回到數值表確認，送出前仍需完成八個方向。

選用 Tobii 時，設定畫面與主選單會顯示接收筆數、有效筆數及有效注視座標。「有接收資料但無有效注視」代表裝置當時未提供有效位置；請先在 Tobii Experience 確認眼睛偵測與螢幕對齊，再進行五點驗證。連線成功不代表已取得可計分的眼動資料。

成績結算與 CSV／JSON 會記錄各方向的複視角度（°），以正前方為 0°，依標記位置、填答時的訓練畫面大小、螢幕實體尺寸與觀看距離換算。未填寫新問卷的練習沿用最近結果，並保留來源模組、填答時間及原螢幕設定。問卷填寫時間不計入訓練時間。

使用筆電搭配外接螢幕時，先在預定測試螢幕上設定與校正；Tobii Experience 的校正螢幕也必須是同一個螢幕。宿主依視窗所在螢幕與實體像素更新座標，不寫死解析度或縮放比例。測驗中視窗尺寸改變可能使測驗中止。

從 v1.1.0 升級至 Tauri 版時，請重新設定螢幕尺寸、觀看距離與校正；原有 `Data/` CSV 可繼續保留。

## 模組與指標

### 個人表現分析

點選初始設定或主選單上方的 **Analysis**，在獨立視窗比較同一受試者跨日期、跨模組的任務表現。分析會自動讀取 EXE 旁的 `Data/`，也可批次匯入其他資料夾的 CSV／JSON；僅在本機處理，不修改原始紀錄。

可篩選受試者、日期、模組、追蹤來源與方向，查看時間加權的平均偏差、離散程度 SD₂D、RMSE 及命中率。不同刺激設定及追蹤來源分開；命中率額外依實際門檻分組。八方向複視以真正填答時間去重，沿用問卷不算新量測，「無複視」不當成 0°。摘要可匯出至 `Data/Analysis/`。

分析程式、入口與測試獨立維護於 [modules/analysis/](modules/analysis/README.md)，建置時自動內嵌同一個 EXE。舊 JSON 缺少逐筆目標座標時只能顯示原有摘要，方向誤差需搭配同次 CSV。詳細格式與公式見分析模組說明。

| 模組 | 刺激流程 | Accuracy 計分 |
| --- | --- | --- |
| VOR | 1–2x 倍數，選擇左右／上下頭動；目標持續變換顏色與數字 | 有效追蹤時間 |
| Smooth Pursuit | 中心 → 設定範圍端點 → 連續回到中心 | 去程與回程；排除中央十字 |
| Fixation | 目標移至設定範圍端點後停留 | 僅計端點停留；排除中央十字及移動途中 |
| Saccade | 目標在選定的九宮格位置間躍遷 | 沿用目標命中計分，每次目標出現後前 200 ms 排除；另計 TFF |

VOR 的 **VOR Multiplier** 可選 1.0–2.0x（每格 0.1x），**Head Movement Direction** 可選左右或上下。1x 時圓點固定中央，只有頭動；2x 時圓點依頭部旋轉角度反向移動相同角度；1.5x 則反向移動一半角度。系統只使用所選軸的旋轉角度，排除另一軸的移動。超過 1x 時，即使 Eye tracking 為 Off 也需要攝影機；開始前請面向正前方並按下繼續，以建立中立姿勢。頭部角度由攝影機 FaceMesh 估算，圓點位置依螢幕實體尺寸與觀看距離換算，超過畫面時限制於邊緣；攝影機失去追蹤時會中止訓練。JSON 設定與 CSV 報告會保留倍數、方向。

VOR 選用 Tobii 或 WebGazer 時，每次開始前都會重新進行五點注視誤差驗證，並在訓練中記錄 gaze point。CSV／JSON 保留眼動座標、來源時間戳與本次驗證的動態誤差閾值；有效驗證資料不足時無法開始訓練。

螢幕設定的 Horizontal／Vertical angle 是整個螢幕的總視角。Pursuit、Fixation 與 Saccade 的 **Horizontal／Vertical Target Span** 以滑桿分別控制左右、上下兩側目標中心之間的總視角，顯示目前數值及上限；實際像素位置與滑桿上限依輸入的實體螢幕長寬及觀看距離換算，並預留目標半徑，避免刺激超出畫面。調大目標時，上限會同步縮小，超出上限的設定會自動調整。Pursuit 會移至設定範圍的端點後返回中心，Fixation 會在該端點停留；CSV／JSON 會保留各模組的範圍設定。未曾設定範圍的舊資料，Pursuit／Fixation 沿用原畫面邊緣，Saccade 沿用原九宮格各格中央的位置。

**Hit Distance Threshold** 是眼睛與目標中心之間的命中容許誤差，只影響 Accuracy。滑桿與數字欄共用依螢幕對角視角計算的上限，設定會隨模組儲存；刺激大小、跳躍範圍與命中誤差是各自獨立的參數。

Accuracy 採時間加權：

```text
Accuracy = 命中目標的有效計分時間 ÷ 全部有效計分時間 × 100%
```

無效樣本與排除階段不加入計分分母。實際命中閾值採以下兩者的較大值：

- 設定閾值加追蹤器誤差容許值：Tobii 為 1°，WebGazer 為 2°。
- 同來源五點驗證的動態閾值：平均驗證誤差的兩倍，最低 0.5°。

**Saccade Time To First Fixation（TFF）** 從每次目標出現開始計時，先偵測眼動，再找首次穩定注視；不要求落在目標範圍內。判定條件為角速度不超過 30°/秒、持續至少 100 ms，且至少 3 筆有效樣本。無效樣本或超過 100 ms 的缺口會中斷注視。

TFF 使用注視的開始時間，不包含等待確認的時間，也不受 Accuracy 的 200 ms 容許窗限制。結果同時提供逐目標 TFF、平均值與偵測數；未偵測者為 N/A，不納入平均。

取樣間隔依實際來源時間戳計算。WebGazer 使用推論開始時間；攝影機曝光延遲與螢幕實際顯示延遲尚未量測。WebGazer 雜訊可能影響 TFF 偵測率。

## 資料與網路行為

- 原始 CSV 自動儲存於執行檔旁的 `Data/`，檔名包含受試者代碼、日期、模組與追蹤來源。
- CSV 包含原始視線、刺激座標、誤差、階段與時間戳。Fixation 移動途中等未計分資料仍會保留。
- `accuracy_eligible` 表示樣本當下階段是否可計分；`accuracy_delta_t_ms` 是該有效樣本實際計入的時間。`is_within_threshold` 僅代表空間命中，不能以命中樣本比例取代 Accuracy。
- 無效注視不等於眨眼。目前沒有依眼瞼開合或瞳孔訊號運作的 blink 偵測器，因此 JSON 的 `blink_sec` 保留為 `null`，CSV 顯示 N/A；舊版此欄實際累計的是無效追蹤時間，不能解釋為眨眼時長。
- `gaze_data_loss` 在 JSON 與 CSV 註解中保留無效樣本數及逐段 `start_ms`／`end_ms`／`duration_ms`，時間以 `trial_time_ms` 為準（有來源時間戳時採來源時間，否則為接收時間）。樣本狀態延續至下一筆樣本；間隔超過 100 ms 時，整段標記為 `missing_samples`；第一筆之前、最後一筆之後及完全沒有資料的記錄標記為 `unobserved_boundary`。其餘無效區段為 `invalid_gaze`，所有遺失原因均標為 `unknown`。
- `invalid_gaze_sec` 是上述無效區段時長；`gaze_missing_duration_ms` 是未觀測區段總時長，包含長缺口及記錄首尾。這是資料品質的區段估計，與 Accuracy 按模組階段積分的 `valid_sec` 不同，亦不是以原生取樣率計算的遺失樣本百分比。100 ms 是本程式的長缺口判準，不是 guideline 規定的眨眼門檻；不插補資料，也不額外排除缺口前後 75 ms 的樣本。
- Saccade 另輸出 `gaze_velocity_deg_s`、`is_fixation`、`tff_ms` 及逐目標摘要。CSV 使用 UTF-8 BOM，方便 Excel 開啟。
- 左右眼分開記錄：`right_*` 為受試者右眼（OD），`left_*` 為左眼（OS）；`stimulus_h_deg`／`stimulus_v_deg` 為目標相對畫面中心的角度（右、上為正）。
  - WebGazer：以同一次九點校正另外訓練左眼、右眼各自的模型，輸出每眼注視點（`*_gaze_x_px`／`*_gaze_y_px`）、每眼與目標的誤差（`*_error_deg`），以及左眼減右眼的分離角度（`eye_disparity_h_deg`／`eye_disparity_v_deg`／`eye_disparity_deg`；水平正值代表左眼注視點在右眼注視點的右側，即交叉方向）。單眼估計的雜訊比雙眼合併的注視點大，建議以中心位置的分離角度作為同一次測驗的基準。
  - Tobii：Eye Tracker 5 的一般授權資料流只提供兩眼合併的注視點，不提供每眼注視點，因此不計算分離角度；改記錄每眼是否偵測到（`*_eye_valid`）及每眼的 3D 位置（`*_eye_origin_x_mm`／`_y_mm`／`_z_mm`，追蹤器座標）。裝置拒絕此資料流時，狀態列與 CSV 會顯示原因。
- 現有程式會查詢網路時間；測驗結束後會將工作階段資料排入 jsPsych Pipe 上傳佇列，並發送 Discord 完成通知。上傳失敗的資料保留於本機佇列，之後重試。相關設定及流程位於 [wwwroot/training.js](wwwroot/training.js)。
- 執行檔目前保留首次啟動起 30 日的期限檢查及時鐘回退檢查。

## 從原始碼建置

需要 Windows x64、Node.js、Rust stable（MSVC toolchain）、Visual Studio C++ Build Tools 與 Windows SDK。完整需求見 [Tauri 官方文件](https://v2.tauri.app/start/prerequisites/)。不需要 .NET SDK。

```powershell
git clone https://github.com/ian030590/OcuTrain.git
cd OcuTrain
npm ci
npm run build
```

發布檔位於 `dist/`，檔名自動採用 `OcuTrain_<版本>_x64-portable.exe`。專案會將網頁、模型與 Tobii DLL 內嵌於單一執行檔，不攜帶 .NET 或 Chromium 執行環境。開發時使用 `npm run dev`。

執行自動測試：

```powershell
npm test
npm run test:native
```

## 專案結構

- [src-tauri/](src-tauri/)：Tauri 2 宿主、Tobii 原生串流與 SDK 時鐘、DPI、全螢幕及檔案儲存。
- [wwwroot/desktop.js](wwwroot/desktop.js)：Tauri 事件與命令橋接。
- [wwwroot/training.js](wwwroot/training.js)：校正、刺激、計分、TFF 與匯出。
- [tests/](tests/)：追蹤橋接、時間對齊、計分與 WebGazer 執行測試。
- [modules/analysis/](modules/analysis/)：獨立的資料解析、跨日期與方向分析、圖表入口及測試；由 `scripts/prepare-analysis.cjs` 準備內嵌資源。
- [產品與技術規格](PRD_TRD_眼動訓練系統.md)：參數與計算細節。

## 版本與授權

版本使用 `MAJOR.MINOR.PATCH`（大版本.中版本.小修正）：重大不相容變更升大版本、新增功能升中版本、問題修正升小版本。初始正式版為 `v1.0.0`，Accuracy／TFF 更新為 `v1.1.0`，Windows Tauri 2 遷移為 `v1.2.0`，Saccade 刺激範圍與命中門檻修正為 `v1.2.1`，目標範圍滑桿及介面操作修正為 `v1.2.2`，Pursuit／Fixation 目標範圍控制為 `v1.3.0`，八方向複視角度問卷及定期填答為 `v1.4.0`，全螢幕複視標記、Tobii 資料狀態及左右眼分開匯出為 `v1.5.0`，UI 移除 Tobii 功能為 `v1.5.1`。

Release 標題與 EXE 附件使用 `OcuTrain_<版本>_x64-portable.exe`，Git tag 使用 `v<版本>`。

`v1.6.0` 新增 VOR 1–2x 倍數、左右／上下方向及攝影機頭部角度控制。

`v1.6.2` 將 validation 後的 Effective Hit Threshold 改為小於 6° 綠色、6° 至未滿 8° 黃色、8° 起紅色；VOR 移動目標加入 50ms 時間常數的平滑處理，以減少 2x 左右／上下移動時的抖動。

`v1.7.0` 恢復 Tobii 來源選單、硬體校正確認、重新驗證與即時資料狀態；CSV／JSON 分開標記無效追蹤及未觀測時段，`blink_sec` 改為 `null`，避免把追蹤失敗解釋為眨眼。

`v1.8.0` 新增內嵌的個人表現分析視窗，分析程式於 `modules/analysis/` 獨立維護，可比較跨日期的角度誤差、命中率及八方向複視紀錄。

本專案採用 **GNU Affero General Public License v3.0（AGPL-3.0）**，完整條文見 [LICENSE](LICENSE)。第三方函式庫、模型及 Tobii 元件保留各自的授權與著作權聲明；本專案授權不會取代其條款。隨附的 WebGazer 保留 GPLv3 聲明，jsPsych 保留 MIT 聲明。
