OcuTrain 專案檢視與輸入輸出相容性紀錄，2026-10-21。

anti-slop 使用 DURING 模式，來源為本次使用者指示。設計承接既有黑白訓練介面與 PRD 的原生控制項、Zero Emoji 方向，ENERGY 1／RHYTHM 1／MOTION 1。白色用於目前操作與選取狀態；一致的表單順序、角分單位和數值對齊服務於訓練設定。訓練刺激的時序與動畫維持原有行為。

已修正五類介面問題：

1. Target Size、Hit Distance Threshold 滑桿補上對應 label。
2. 刺激類型與方向按鈕補上 aria-pressed，選擇改變時同步更新。
3. 移除覆蓋鍵盤焦點的 outline: none；焦點環改為白色，輸入框與滑軌邊界提高對比。
4. 滑桿操作區改為 44 px 高，保留 8 px 軌道；關閉按鈕與次要按鈕至少 44 px。
5. 頁首提示可換行；窄螢幕受試者代碼欄與產生代碼按鈕改為直排，修正文字裁切。

本次應用程式修改限於 wwwroot/index.html 的樣式，以及 wwwroot/app.js 的 label、ARIA 狀態與其同步。測試、設定讀取、視角換算、追蹤計分、CSV 與工作階段資料產生邏輯均保留。上一輪尚未提交的 Target Span 滑桿修改已包含在本次基準內。

相容性檢查採用本機 code-modernization 1.0.0 的 characterization testing 原則與 scripts/compare.py。比較器逐位元組比較實際輸出，沒有使用遮罩、浮點容忍值或核准差異。

| 檢查 | 結果 | 證據 |
| --- | --- | --- |
| 修改前既有測試 | 58 執行、0 失敗、0 跳過 | [baseline/tests.xml](baseline/tests.xml) |
| 修改後相同測試 | 58 執行、0 失敗、0 跳過 | [equivalence/tests.xml](equivalence/tests.xml) |
| 30 組輸入、54 份輸出 | 54 份完全相同、0 缺檔、0 差異 | [EQUIVALENCE.json](equivalence/EQUIVALENCE.json) |
| 其中 12 組額外輸入 | 24 份輸出完全相同 | [FRESH_EQUIVALENCE.json](equivalence/FRESH_EQUIVALENCE.json) |
| 比較器自我檢查 | 改變任一基準輸出的一個位元組後，可偵測差異 | 同上結果的 selfCheck |
| 故意破壞隔離副本 | Tobii 容許誤差增加 0.25 度後，49 項測試有 5 項失敗、54 份輸出有 16 份不同 | [canary-tests.xml](equivalence/canary-tests.xml)、[CANARY_EQUIVALENCE.json](equivalence/CANARY_EQUIVALENCE.json) |
| 原始基準完整性 | 保存的 7 份基準檔案 SHA-256 均未變動 | [checks.json](checks.json)、[source-hashes.json](baseline/source-hashes.json) |

30 組輸入包含四種訓練模組 × Tobii、WebGazer、Off 的 12 組組合，12 組不同螢幕尺寸、距離、目標大小、門檻與時序設定，以及 6 組無效門檻。比較內容包含參數讀取與錯誤結果、儲存及還原的設定、校正資料、邊界檢查、工作階段 JSON、刺激事件與時間戳、Accuracy／TFF、完整 CSV 文字與檔名。日期與亂數由測試主機固定，兩側使用相同合成視線輸入；應用程式本身未為比較而改寫。

比較器的實際結論為 `PROVEN: 54 case(s) executed, none differ`。此結論限於上述資料契約與輸入，原始結果、輸入及執行器均保存在 [equivalence](equivalence)；它不代表所有可能輸入或實機硬體行為均已被證明。

介面在 Chromium 實際操作 9 種畫面，各以 1366、800、390、320 px 寬度檢查，共 36 個畫面。受檢畫面為初始設定、選單、四模組設定、距離設定、追蹤來源設定、說明。最後一次檢查沒有啟用控制項的標籤、選取狀態、焦點、44 px 操作區、受檢文字 AA 對比或水平裁切問題，也沒有未捕捉的 JavaScript 例外。結果見 [ui-current/audit.json](ui-current/audit.json)，修改前紀錄見 [ui-baseline/audit.json](ui-baseline/audit.json)。

已記錄的操作：

| 操作 | 實際結果 |
| --- | --- |
| 初始螢幕與距離輸入、儲存 | 更新換算資料並進入選單 |
| 四模組 Configure | 開啟對應設定表單 |
| Evaluation／Predictable／Random | 模式值與預覽同步 |
| 三種刺激、方向及 ALL | 實際設定更新；ARIA 狀態與畫面選擇一致 |
| 目標大小、命中門檻的滑桿與數字欄 | 雙向同步；無效門檻顯示需輸入有效值 |
| Target Span 滑鼠及 Home／End／方向鍵 | 值與預覽同步，可達最小與最大值 |
| 改變目標大小、重新設定螢幕與距離 | 兩個 Span 上限重新計算，超限值縮回有效範圍 |
| Start | 兩個 Span 值實際存入設定 |
| 距離、來源、說明對話框 | 開啟成功，Escape 可關閉 |

anti-slop Delivery Gate 以下以本次修改及上述受檢畫面為範圍。PASS 表示有相應程式或執行證據；不延伸至未執行的實機流程。

| 規則 | 狀態與證據 |
| --- | --- |
| R-01 色彩與漸層 | PASS：沿用黑白介面，沒有新增漸層或裝飾光暈。 |
| R-02 文案 | PASS：本次沒有新增 em dash，原有狀態字串保持相容。 |
| R-03 響應與操作區 | PASS：36 個畫面無受檢溢位，啟用控制項至少 44 px。 |
| R-04 圖示 | PASS：沒有新增裝飾圖示，方向箭頭仍表示實際方向。 |
| R-05 結構 | PASS：保留訓練模組與設定流程，沒有新增樣板區塊。 |
| R-06 字體 | PASS：沿用既有字體；數值使用 tabular-nums 方便比較參數。 |
| R-07 背景 | PASS：沒有新增背景網格或紋理。 |
| R-08 按鈕箭頭 | PASS：箭頭僅用於方向控制。 |
| R-09 標記 | PASS：滑桿數值與方向數量均對應實際狀態。 |
| R-10 透明模糊 | PASS：既有平面介面保留 backdrop-filter: none。 |
| R-11 圓角 | PASS：沿用既有控制項與面板尺寸區分。 |
| R-12 陰影 | PASS：沒有新增面板陰影。 |
| R-13 光暈 | PASS：焦點使用實線框，沒有新增裝飾光暈。 |
| R-14 並列元件 | PASS：四模組同層比較，沿用一致的功能入口。 |
| R-15 操作文字 | PASS：保留 Configure、Start、Save settings 等實際操作。 |
| R-16 空泛詞彙 | PASS：未新增宣傳詞彙。 |
| R-17 數字 | PASS：設定與視角數字取自真實輸入；測試資料明確為合成資料。 |
| R-18 證言 | PASS：沒有新增人物、客戶或證言。 |
| R-19 動態 | PASS：設定介面無新增動畫；訓練刺激時序不變。 |
| R-20 識別與層級 | PASS：保留模組、角分、觀看距離、受試者代碼等訓練內容層級。 |
| R-21 主題 | PASS：沿用既有黑底白色訓練視覺。 |
| R-22 插圖 | PASS：沒有新增插圖。 |
| R-23 資產 | PASS：沒有新增品牌、人物或導航資產。 |
| R-24 導航 | PASS：受檢入口均開啟實際模組或對話框。 |
| R-25 對比 | PASS：受檢可見文字通過 AA 計算，焦點環使用白色。 |
| R-26 功能 | PASS：上述操作表與瀏覽器紀錄確認實際互動。 |
| R-27 狀態 | PASS：初始空值、無效門檻及既有儲存／相機失敗測試均保留。 |
| R-28 FAQ | PASS：沒有新增 FAQ。 |
| R-29 色盤 | PASS：灰階表單與既有提示色保持一致。 |
| R-30 仿製 | PASS：沒有新增其他產品的版面或元件。 |
| R-31 決策理由 | PASS：每項修改均對應標籤、焦點、操作區或裁切問題。 |
| R-32 鍵盤 | PASS：受檢控制項有可見焦點，滑桿鍵盤操作與 Escape 已執行。 |
| R-33 修改方式 | PASS：介面直接在原始碼修改；隔離副本僅供故障驗證。 |
| R-34 主題狀態 | PASS：本次未新增主題切換。 |
| R-35 執行驗證 | PASS：58 項測試、36 個瀏覽器畫面及輸出比較均有原始紀錄。 |
| R-36 真實聲明 | PASS：未新增安全、醫療效果或效能聲明。 |
| R-37 方向 | PASS：本紀錄列明既有設計方向與三項 dials。 |
| R-38 內容 | PASS：保留實際訓練名稱、設定與計算結果。 |
| Liveliness | PASS：1／1／1 與平靜表單相符；主操作、留白、選取框及角分數值形成既有層級。 |
| C-1 意圖 | PASS：五類修正均有具體操作目的。 |
| C-2 完整性 | PASS：互動與儲存均有執行證據。 |
| C-3 內容 | PASS：沒有新增無關區塊。 |
| C-4 韌性 | PASS：本次受檢寬度、錯誤輸入與鍵盤狀態通過。 |
| C-5 證據 | PASS：數量由 XML／JSON 解析，未以人工填入取代測試紀錄。 |

後續維護觀察：app.js 仍在單一閉包內處理設定 UI、追蹤、計分、報表與上傳，index.html 也保留樣式覆蓋層。這增加定位修改的成本；本次保留其結構，避免為介面檢視擴大資料行為變動。既有外部字體、網路時間、上傳及通知整合均保留，瀏覽器驗證以本機回應攔截外部請求。

未涵蓋：實際 Tobii／攝影機量測、WebView2 原生視窗與 DPI 實測、Rust 原生測試、正式遠端服務、200% 系統縮放、所有可能的視線輸入。此環境沒有可用的 cargo 指令，本次沒有執行原生建置，也沒有重新打包 Windows 執行檔。所有由驗證啟動的本機伺服器與瀏覽器均已關閉，故障注入僅存在 .tools/anti-slop-canary 副本。
