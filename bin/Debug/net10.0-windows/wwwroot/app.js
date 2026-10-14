
    // ════════════════════════════════════════════════════
    // ██  Tobii Native Host Bridge 監聽器 (33 Hz 原生串流)
    // ════════════════════════════════════════════════════
    window.handleNativeTobiiMessage = function(payload) {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "gaze") {
        recordTobiiSample(payload);
      }
    };


  "use strict";

  (() => {
    // ════════════════════════════════════════════════════
    // ██  個案姓名與 Webhook 設定 ── 請在此修改為實際個案姓名與 Webhook
    // ════════════════════════════════════════════════════
    const PATIENT_NAME = "特殊需求視覺中心";
    const DISCORD_WEBHOOK_URL = "nothing";

    const SUBTEST_NAMES = {
      vor: "VOR",
      pursuit: "Pursuit",
      saccade: "Saccade",
      fixation: "Fixation"
    };

    async function sendDiscordNotification(moduleKey) {
      const moduleName = SUBTEST_NAMES[moduleKey] || (MODULES[moduleKey] && MODULES[moduleKey].code) || moduleKey;
      const message = `${PATIENT_NAME}已完成一次${moduleName}！`;
      try {
        await fetch(DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: message
          })
        });
      } catch (err) {
        console.error("Discord webhook notification failed:", err);
      }
    }

    // ════════════════════════════════════════════════════
    // ██  時間炸彈：首次啟動後 1 個月鎖死
    //     防護層：連線網路時間 + 上次啟動時間反推倒退
    // ════════════════════════════════════════════════════
    const EXPIRY_LS_KEY      = "ocm-first-launch-ts";  // 首次啟動（毫秒 UNIX）
    const LAST_SEEN_LS_KEY   = "ocm-last-seen-ts";     // 上次成功啟動（毫秒 UNIX）
    const ONE_MONTH_MS       = 30 * 24 * 60 * 60 * 1000;  // 30 天
    const ROLLBACK_GRACE_MS  = 5 * 60 * 1000;              // 容許 5 分鐘誤差

    /**
     * 嘗試從三個時間源取得最可信的當前時間（取最大值）。
     * 優先序：WorldTimeAPI → timeapi.io → 本機時間
     * 任一來源成功即採用，並以本機時間做下界保護。
     */
    async function fetchNetworkTime() {
      const localNow = Date.now();
      const sources = [
        () => fetch("https://worldtimeapi.org/api/ip",      { cache: "no-store" })
                .then(r => r.json()).then(d => new Date(d.datetime).getTime()),
        () => fetch("https://timeapi.io/api/time/current/zone?timeZone=UTC", { cache: "no-store" })
                .then(r => r.json()).then(d => new Date(`${d.dateTime}Z`).getTime()),
      ];

      for (const src of sources) {
        try {
          const t = await Promise.race([
            src(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
          ]);
          if (Number.isFinite(t) && t > 0) {
            // 若網路時間落後本機超過 1 分鐘以上，可能是本機時間被調快
            // 但仍以「最大值」作為最保守的到期判斷
            return Math.max(t, localNow);
          }
        } catch (_) { /* 繼續下一個來源 */ }
      }
      // 所有網路來源不可用，退回本機時間（允許離線，但已記錄上次網路時間）
      return localNow;
    }

    /**
     * 顯示永久鎖定畫面，傳入 reason 說明鎖定原因。
     * 攔截所有輸入，防止任何方式繞過。
     */
    function showLockscreen(reason = "expired") {
      const messages = {
        expired:  "已超過期限，請聯繫治療師取得進一步復能計畫",
        rollback: "偵測到時間異常，請聯繫治療師取得進一步復能計畫",
      };
      const details = {
        expired:  "此訓練檔案的使用授權已到期。<br>如需繼續使用，請與您的視覺復能治療師聯繫。",
        rollback: "系統偵測到本機時間被調整，為保護訓練計畫完整性，<br>檔案已自動鎖定。請聯繫您的視覺復能治療師。",
      };

      const root = document.getElementById("experiment-root");
      if (root) root.style.display = "none";

      const lock = document.getElementById("lockscreen");
      const h2   = lock && lock.querySelector("h2");
      const p    = lock && lock.querySelector("p");
      if (lock) {
        if (h2) h2.textContent = messages[reason] || messages.expired;
        if (p)  p.innerHTML    = details[reason]  || details.expired;
        lock.classList.add("active");
      } else {
        document.body.innerHTML =
          `<div id="lockscreen" class="active">
             <div class="lock-icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--danger, #ef4444); display:inline-block;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></div>
             <h2>${messages[reason] || messages.expired}</h2>
             <p>${details[reason]  || details.expired}</p>
           </div>`;
      }

      // 阻斷所有使用者輸入
      ["keydown","keyup","keypress","click","mousedown","mouseup","contextmenu","touchstart"]
        .forEach(evt => document.addEventListener(evt, e => e.preventDefault(), true));
    }

    /** 主要到期 + 時間倒退檢查 */
    async function checkExpiry() {
      const nowMs = await fetchNetworkTime();

      // ── 1. 首次啟動記錄 ──────────────────────────────
      let firstLaunchMs = Number(localStorage.getItem(EXPIRY_LS_KEY));
      if (!firstLaunchMs || isNaN(firstLaunchMs)) {
        firstLaunchMs = nowMs;
        localStorage.setItem(EXPIRY_LS_KEY, String(firstLaunchMs));
      }

      // ── 2. 時間倒退偵測 ──────────────────────────────
      //    比對本次時間與上次成功記錄的時間
      const lastSeenMs = Number(localStorage.getItem(LAST_SEEN_LS_KEY));
      if (lastSeenMs && !isNaN(lastSeenMs)) {
        // 若現在時間比「上次記錄」早超過容許誤差 → 時間遭到回撥
        if (nowMs < lastSeenMs - ROLLBACK_GRACE_MS) {
          showLockscreen("rollback");
          return;  // 不再繼續，直接鎖死
        }
      }

      // ── 3. 到期檢查 ──────────────────────────────────
      const expiryMs = firstLaunchMs + ONE_MONTH_MS;
      if (nowMs >= expiryMs) {
        showLockscreen("expired");
        return;
      }

      // ── 4. 更新「上次啟動時間」（僅在通過所有檢查後才更新）
      //    取 nowMs 與現有記錄的最大值，確保只會向前推進
      const newLastSeen = Math.max(nowMs, lastSeenMs || 0);
      localStorage.setItem(LAST_SEEN_LS_KEY, String(newLastSeen));
    }

    // 立即執行到期檢查（非阻塞；鎖定畫面 CSS z-index 會蓋在所有內容上方）
    checkExpiry();

    const { ParameterType } = jsPsychModule;
    const SUBJECT_ID_STORAGE_KEY = "oculomotor-subject-id-v1";

    function escapeHtml(str) {
      if (str === null || str === undefined) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function getInitialSubjectId() {
      try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get("subject_id") || params.get("user_id") || params.get("participant");
        if (fromUrl && fromUrl.trim()) {
          const cleanUrlId = fromUrl.trim();
          try { localStorage.setItem(SUBJECT_ID_STORAGE_KEY, cleanUrlId); } catch (_) {}
          return cleanUrlId;
        }
      } catch (_) {}

      try {
        const fromStorage = localStorage.getItem(SUBJECT_ID_STORAGE_KEY);
        if (fromStorage && fromStorage.trim()) {
          return fromStorage.trim();
        }
      } catch (_) {}

      const randomId = "SUBJ_" + Math.random().toString(36).slice(2, 8).toUpperCase();
      try { localStorage.setItem(SUBJECT_ID_STORAGE_KEY, randomId); } catch (_) {}
      return randomId;
    }

    function updateSubjectId(newId, fallbackIfEmpty = false) {
      const trimmed = (newId || "").trim();
      if (trimmed) {
        subjectId = trimmed;
        try { localStorage.setItem(SUBJECT_ID_STORAGE_KEY, subjectId); } catch (_) {}
      } else if (fallbackIfEmpty) {
        subjectId = "SUBJ_" + Math.random().toString(36).slice(2, 8).toUpperCase();
        try { localStorage.setItem(SUBJECT_ID_STORAGE_KEY, subjectId); } catch (_) {}
      }
      if (window.jsPsychInstance && subjectId) {
        window.jsPsychInstance.data.addProperties({ subject_id: subjectId });
      }
      return subjectId;
    }

    const RAD_PER_ARCMIN = Math.PI / 10800;
    const ARCMIN_PER_RAD = 10800 / Math.PI;
    const RAD_PER_ARCSEC = Math.PI / 648000;
    const ARCSEC_PER_RAD = 648000 / Math.PI;
    const EVALUATION = "evaluation";
    const PREDICTABLE = "predictable";
    const RANDOM = "random";
    const EYE_SOURCE_OFF = "off";
    const EYE_SOURCE_WEBGAZER = "webgazer";
    const EYE_SOURCE_TOBII = "tobii";
    const DISPLAY_SETTINGS_KEY = "oculomotor-display-settings-v1";
    const TOBII_SAMPLE_INTERVAL_MS = 0;
    const TOBII_MAX_SAMPLES_PER_TRIAL = 36000;
    const WEBGAZER_COMPONENTS_AVAILABLE = Boolean(
      window.webgazer &&
      window.jsPsychExtensionWebgazer &&
      window.jsPsychWebgazerInitCamera &&
      window.jsPsychWebgazerCalibrate
    );
    const bridgeQuery = new URLSearchParams(window.location.search);
    const bridgeHash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const bridgeToken = bridgeQuery.get("bridgeToken") || bridgeHash.get("bridge_token") || "";
    const bridgePort = Number(bridgeQuery.get("bridgePort")) || 8080;
    const bridgeHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
      ? window.location.host
      : `127.0.0.1:${bridgePort}`;
    const bridgeProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const configuredBridgeUrl = bridgeQuery.get("bridgeToken")
      ? `${bridgeProtocol}//${bridgeHost}/gaze?token=${encodeURIComponent(bridgeToken)}`
      : null;
    const injectedBridgeClient = window.TobiiBridge || null;

    const MODULES = {
      vor: {
        code: "VOR",
        name: "Vestibulo-Ocular Reflex",
        short: "Central target recognition",
        description: "Keep your gaze on the center target while its color and number change."
      },
      pursuit: {
        code: "PURSUIT",
        name: "Smooth Pursuit",
        short: "Linear target tracking",
        description: "Follow a target moving at a constant speed from the center toward selected screen-edge positions."
      },
      saccade: {
        code: "SACCADE",
        name: "Saccade",
        short: "Grid jumps",
        description: "Shift your gaze as the target jumps between selected positions in the 3 × 3 grid."
      },
      fixation: {
        code: "FIXATION",
        name: "Fixation",
        short: "Movement and edge hold",
        description: "Follow the target to the screen edge and keep your gaze fixed while it remains there."
      }
    };

    const ALL_DIRECTIONS = [
      "leftUp", "middleUp", "rightUp",
      "leftMiddle", "rightMiddle",
      "leftDown", "middleDown", "rightDown"
    ];

    const NINE_GRID_SLOTS = [
      { type: "dir", key: "leftUp",      label: "左上", arrow: "↖" },
      { type: "dir", key: "middleUp",    label: "上",   arrow: "↑" },
      { type: "dir", key: "rightUp",     label: "右上", arrow: "↗" },
      { type: "dir", key: "leftMiddle",  label: "左",   arrow: "←" },
      { type: "center", key: "all",      label: "全選", arrow: "ALL" },
      { type: "dir", key: "rightMiddle", label: "右",   arrow: "→" },
      { type: "dir", key: "leftDown",    label: "左下", arrow: "↙" },
      { type: "dir", key: "middleDown",  label: "下",   arrow: "↓" },
      { type: "dir", key: "rightDown",   label: "右下", arrow: "↘" }
    ];

    const STIMULUS_TYPES = {
      white_dot: { id: "white_dot", name: "White dot", meta: "標準白點 (實心純白)" },
      red_in_white: { id: "red_in_white", name: "Red in White", meta: "白底紅心 (內嵌紅點)" },
      numbers_dot: { id: "numbers_dot", name: "Numbers dot", meta: "數字變色球 (動態切換)" }
    };

    const MODULE_DEFAULTS = {
      vor: { ballArcmin: 60, changeMs: 500, totalSec: 30 },
      pursuit: { mode: PREDICTABLE, stimulusType: "white_dot", ballArcmin: 60, speedArcminSec: 300, totalSec: 45, directions: [...ALL_DIRECTIONS] },
      saccade: { mode: PREDICTABLE, stimulusType: "white_dot", ballArcmin: 60, dwellMs: 500, totalSec: 45, directions: [...ALL_DIRECTIONS] },
      fixation: { mode: PREDICTABLE, stimulusType: "white_dot", ballArcmin: 60, speedArcminSec: 300, holdSec: 2, totalSec: 60, directions: [...ALL_DIRECTIONS] }
    };

    const EDGE_SEQUENCE = [
      "rightUp", "leftUp", "rightDown", "leftDown",
      "middleUp", "middleDown", "leftMiddle", "rightMiddle"
    ];

    const SACCADE_SEQUENCE = [
      "rightUp", "leftUp", "rightUp", "leftUp",
      "rightDown", "leftDown", "rightDown", "leftDown",
      "rightMiddle", "leftMiddle", "rightMiddle", "leftMiddle",
      "middleUp", "middleDown", "middleUp", "middleDown",
      "rightUp", "rightDown", "rightUp", "rightDown",
      "leftUp", "leftDown", "leftUp", "leftDown"
    ];

    const DIRECTION_LABELS = {
      rightUp: "右上 (Upper right)",
      leftUp: "左上 (Upper left)",
      rightDown: "右下 (Lower right)",
      leftDown: "左下 (Lower left)",
      rightMiddle: "右 (Middle right)",
      leftMiddle: "左 (Middle left)",
      middleUp: "上 (Top center)",
      middleDown: "下 (Bottom center)",
      center: "中央 (Center)"
    };

    const GRID_KEYS = [
      "leftUp", "middleUp", "rightUp",
      "leftMiddle", "center", "rightMiddle",
      "leftDown", "middleDown", "rightDown"
    ];

    const VOR_COLORS = [
      "#63e6ff", "#b9f66d", "#ffd166", "#ff8295",
      "#c7a7ff", "#ff9f5b", "#76f2c6", "#f4f7fb"
    ];

    const MODULE_SETTINGS_KEY = "oculomotor-module-settings-v1";

    function readStoredModuleSettings() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(MODULE_SETTINGS_KEY) || "null");
        if (!parsed || typeof parsed !== "object") return null;
        const merged = JSON.parse(JSON.stringify(MODULE_DEFAULTS));
        for (const [modKey, defaults] of Object.entries(MODULE_DEFAULTS)) {
          if (parsed[modKey] && typeof parsed[modKey] === "object") {
            merged[modKey] = { ...defaults };
            for (const [k, v] of Object.entries(parsed[modKey])) {
              if (v !== undefined && v !== null) {
                merged[modKey][k] = v;
              }
            }
          }
        }
        return merged;
      } catch (error) {
        return null;
      }
    }

    function saveStoredModuleSettings(settings) {
      try {
        window.localStorage.setItem(MODULE_SETTINGS_KEY, JSON.stringify(settings));
        return true;
      } catch (error) {
        return false;
      }
    }

    const storedModuleSettings = readStoredModuleSettings();

    const AppState = {
      calibration: null,
      pending: null,
      lastSession: null,
      interactions: [],
      moduleSettings: storedModuleSettings || JSON.parse(JSON.stringify(MODULE_DEFAULTS)),
      eyeTracking: {
        source: EYE_SOURCE_TOBII,
        available: WEBGAZER_COMPONENTS_AVAILABLE,
        enabled: false,
        initialized: false,
        calibrated: false,
        calibrationRequested: false,
        calibratedAt: null,
        calibrationViewport: null,
        lastError: null
      },
      tobii: {
        configured: true,
        endpoint: configuredBridgeUrl,
        status: "connected",
        connected: true,
        provider: "Tobii Eye Tracker 5",
        providerMode: "native_or_simulated",
        coordinateSpace: "normalized",
        hardwareCalibrationConfirmed: true,
        lastError: null,
        lastMessageAt: new Date().toISOString(),
        socket: null,
        connectPromise: null,
        injectedClientBound: true,
        activeTrial: null,
        disconnectListeners: new Set()
      },
      upload: {
        status: "idle",
        pendingCount: 0,
        lastError: null,
        lastFilename: null
      }
    };

    const round = (value, digits = 2) => {
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    };

    const formatNumber = (value, digits = 1) =>
      Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits
      });

    const visualAngleArcmin = (sizeCm, distanceCm) =>
      2 * Math.atan(sizeCm / (2 * distanceCm)) * ARCMIN_PER_RAD;

    const physicalSizeForArcmin = (arcmin, distanceCm) =>
      2 * distanceCm * Math.tan((arcmin * RAD_PER_ARCMIN) / 2);

    const currentScreenPixels = () => ({
      width: Math.max(1, Number(window.screen && window.screen.width) || window.innerWidth || 1),
      height: Math.max(1, Number(window.screen && window.screen.height) || window.innerHeight || 1)
    });

    function createCalibration(values) {
      const screenPixels = currentScreenPixels();
      const screenWidthCm = Number(values.screenWidthCm);
      const screenHeightCm = Number(values.screenHeightCm);
      const viewingDistanceCm = Number(values.viewingDistanceCm);
      const physicalRatio = screenWidthCm / screenHeightCm;
      const pixelRatio = screenPixels.width / screenPixels.height;
      return {
        screenWidthCm,
        screenHeightCm,
        viewingDistanceCm,
        screenWidthPx: screenPixels.width,
        screenHeightPx: screenPixels.height,
        devicePixelRatio: Number(window.devicePixelRatio) || 1,
        horizontalArcmin: visualAngleArcmin(screenWidthCm, viewingDistanceCm),
        verticalArcmin: visualAngleArcmin(screenHeightCm, viewingDistanceCm),
        aspectMismatchPercent: Math.abs(physicalRatio / pixelRatio - 1) * 100,
        createdAt: new Date().toISOString()
      };
    }

    function readStoredDisplaySettings() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(DISPLAY_SETTINGS_KEY) || "null");
        if (!parsed || typeof parsed !== "object") return null;
        const values = {
          screenWidthCm: Number(parsed.screenWidthCm),
          screenHeightCm: Number(parsed.screenHeightCm),
          viewingDistanceCm: Number(parsed.viewingDistanceCm)
        };
        return Object.values(values).every((value) => Number.isFinite(value) && value > 0) ? values : null;
      } catch (error) {
        return null;
      }
    }

    function saveDisplaySettings(calibration) {
      try {
        window.localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify({
          screenWidthCm: calibration.screenWidthCm,
          screenHeightCm: calibration.screenHeightCm,
          viewingDistanceCm: calibration.viewingDistanceCm
        }));
        return true;
      } catch (error) {
        return false;
      }
    }

    const storedDisplaySettings = readStoredDisplaySettings();
    if (storedDisplaySettings) AppState.calibration = createCalibration(storedDisplaySettings);

    function stimulusPixels(arcmin, calibration, screenPixels = currentScreenPixels()) {
      const diameterCm = physicalSizeForArcmin(arcmin, calibration.viewingDistanceCm);
      return {
        width: diameterCm * screenPixels.width / calibration.screenWidthCm,
        height: diameterCm * screenPixels.height / calibration.screenHeightCm,
        diameterCm
      };
    }

    function readPositiveNumbers(form, names) {
      const values = {};
      const errors = [];
      names.forEach((name) => {
        const input = form.elements.namedItem(name);
        const value = Number(input && input.value);
        if (!Number.isFinite(value) || value <= 0) {
          errors.push(input && input.dataset.label ? input.dataset.label : name);
        } else {
          values[name] = value;
        }
      });
      return { values, errors };
    }

    function setError(element, message) {
      if (!element) return;
      element.textContent = message || "";
      element.classList.toggle("is-visible", Boolean(message));
    }

    function eyeTrackingStatusText() {
      if (AppState.eyeTracking.source === EYE_SOURCE_TOBII) {
        if (AppState.tobii.connected) return `Eye tracking: Tobii ${AppState.tobii.providerMode === "simulator" ? "Simulator" : "Ready"}`;
        return "Eye tracking: Tobii disconnected";
      }
      if (AppState.eyeTracking.source === EYE_SOURCE_WEBGAZER) {
        if (!AppState.eyeTracking.available) return "Eye tracking unavailable";
        if (AppState.eyeTracking.calibrated) return "Eye tracking: WebGazer ready";
        return "Eye tracking: Calibration required";
      }
      return "Eye tracking: Off";
    }

    function tobiiStatusText() {
      if (!AppState.tobii.configured) return "Launch this page with Oculomotor Tobii Bridge to use Tobii tracking.";
      if (AppState.tobii.status === "connecting") return "Connecting to the local Tobii Bridge…";
      if (AppState.tobii.connected) {
        const provider = AppState.tobii.provider || "eye tracker";
        const simulator = AppState.tobii.providerMode === "simulator" ? " (simulated data)" : "";
        return `Connected to ${provider}${simulator}.`;
      }
      if (AppState.tobii.lastError) return `Tobii Bridge: ${AppState.tobii.lastError}`;
      return "Tobii Bridge is not connected.";
    }

    function currentViewportSignature() {
      return {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
        screenWidth: Math.round(Number(window.screen && window.screen.width) || 0),
        screenHeight: Math.round(Number(window.screen && window.screen.height) || 0),
        devicePixelRatio: Number(window.devicePixelRatio) || 1,
        fullscreen: Boolean(fullscreenElement())
      };
    }

    function viewportSignaturesMatch(left, right) {
      if (!left || !right) return false;
      return Math.abs(left.width - right.width) <= 1 &&
        Math.abs(left.height - right.height) <= 1 &&
        left.screenWidth === right.screenWidth &&
        left.screenHeight === right.screenHeight &&
        Math.abs(left.devicePixelRatio - right.devicePixelRatio) < 0.001 &&
        left.fullscreen === right.fullscreen;
    }

    async function stopEyeTrackingRuntime() {
      const extension = window.jsPsychInstance && window.jsPsychInstance.extensions
        ? window.jsPsychInstance.extensions.webgazer
        : null;
      AppState.eyeTracking.enabled = false;
      AppState.eyeTracking.source = EYE_SOURCE_OFF;
      AppState.eyeTracking.initialized = false;
      AppState.eyeTracking.calibrated = false;
      AppState.eyeTracking.calibrationRequested = false;
      AppState.eyeTracking.calibratedAt = null;
      AppState.eyeTracking.calibrationViewport = null;
      if (extension) {
        try { extension.pause(); } catch (error) { /* Continue releasing the camera. */ }
        try { extension.hideVideo(); } catch (error) { /* Continue releasing the camera. */ }
        try { extension.hidePredictions(); } catch (error) { /* Continue releasing the camera. */ }
      }
      try {
        if (window.webgazer && typeof window.webgazer.end === "function") {
          await Promise.resolve(window.webgazer.end());
        }
      } catch (error) { /* Media tracks are also stopped by the browser when the page closes. */ }
      if (extension && Object.prototype.hasOwnProperty.call(extension, "initialized")) {
        extension.initialized = false;
      }
    }

    function bridgeField(payload, camelName, snakeName) {
      return payload[camelName] ?? payload[snakeName];
    }

    function optionalNumber(value) {
      if (value === null || value === undefined || value === "") return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }

    function mapTobiiSample(payload, receivedAt) {
      const rawX = Number(bridgeField(payload, "x", "x"));
      const rawY = Number(bridgeField(payload, "y", "y"));
      const sourceWidth = Number(bridgeField(payload, "sourceWidth", "source_width"));
      const sourceHeight = Number(bridgeField(payload, "sourceHeight", "source_height"));
      const coordinateSpace = String(bridgeField(payload, "coordinateSpace", "coordinate_space") || AppState.tobii.coordinateSpace || "unknown");
      const directMonotonicMilliseconds = optionalNumber(bridgeField(payload, "bridgeMonotonicMs", "bridge_monotonic_ms"));
      const monotonicMicroseconds = optionalNumber(bridgeField(payload, "monotonicTimestampMicroseconds", "monotonic_timestamp_microseconds"));
      const monotonicMilliseconds = directMonotonicMilliseconds ?? (monotonicMicroseconds === null ? null : monotonicMicroseconds / 1000);
      const deviceTimestampMicroseconds = optionalNumber(bridgeField(payload, "deviceTimestampMicroseconds", "device_timestamp_microseconds"));
      let x = rawX;
      let y = rawY;
      let mapping = "direct";
      if (coordinateSpace === "viewport_normalized" || coordinateSpace === "normalized") {
        x = rawX * window.innerWidth;
        y = rawY * window.innerHeight;
        mapping = "normalized_to_css_viewport";
      } else if (Number.isFinite(sourceWidth) && sourceWidth > 0 && Number.isFinite(sourceHeight) && sourceHeight > 0 &&
                 (coordinateSpace === "screen_physical" || coordinateSpace === "tracked_window_pixels")) {
        x = rawX * window.innerWidth / sourceWidth;
        y = rawY * window.innerHeight / sourceHeight;
        mapping = "source_pixels_to_css_viewport";
      }
      return {
        sequence: Number(bridgeField(payload, "sequence", "sequence")),
        bridge_received_unix_ms: Number(bridgeField(payload, "bridgeReceivedUnixMs", "bridge_received_unix_ms") ?? bridgeField(payload, "timestamp", "timestamp")),
        bridge_monotonic_ms: monotonicMilliseconds,
        device_timestamp_us: deviceTimestampMicroseconds,
        browser_received_unix_ms: Date.now(),
        browser_trial_time_ms: round(receivedAt - AppState.tobii.activeTrial.startedPerformance, 3),
        raw_x: rawX,
        raw_y: rawY,
        x: Number.isFinite(x) ? round(x, 3) : null,
        y: Number.isFinite(y) ? round(y, 3) : null,
        valid: bridgeField(payload, "valid", "valid") !== false && Number.isFinite(rawX) && Number.isFinite(rawY),
        coordinate_space: coordinateSpace,
        source_width: Number.isFinite(sourceWidth) ? sourceWidth : null,
        source_height: Number.isFinite(sourceHeight) ? sourceHeight : null,
        css_mapping: mapping
      };
    }

    function recordTobiiSample(payload) {
      const active = AppState.tobii.activeTrial;
      if (!active) return;
      const receivedAt = performance.now();
      const directBridgeTime = optionalNumber(bridgeField(payload, "bridgeMonotonicMs", "bridge_monotonic_ms"));
      const bridgeMicroseconds = optionalNumber(bridgeField(payload, "monotonicTimestampMicroseconds", "monotonic_timestamp_microseconds"));
      const bridgeTime = directBridgeTime ?? (bridgeMicroseconds === null ? null : bridgeMicroseconds / 1000);
      const sampleClock = bridgeTime ?? receivedAt;
      if (active.samples.length >= TOBII_MAX_SAMPLES_PER_TRIAL) {
        active.overflow += 1;
        return;
      }
      active.lastAcceptedClock = sampleClock;
      const mapped = mapTobiiSample(payload, receivedAt);
      active.samples.push(mapped);
      if (typeof active.onSample === "function") {
        try { active.onSample(mapped); } catch (e) { console.error("onSample error:", e); }
      }
    }

    function handleTobiiPayload(payload) {
      if (!payload || typeof payload !== "object") return;
      AppState.tobii.lastMessageAt = new Date().toISOString();
      if (payload.type === "bridge_status" || payload.type === "status") {
        const provider = bridgeField(payload, "provider", "provider");
        AppState.tobii.provider = provider && typeof provider === "object"
          ? (bridgeField(provider, "providerDisplayName", "provider_display_name") || bridgeField(provider, "providerId", "provider_id") || null)
          : provider || null;
        AppState.tobii.providerMode = provider && typeof provider === "object"
          ? (bridgeField(provider, "providerId", "provider_id") || null)
          : (bridgeField(payload, "providerMode", "provider_mode") || provider || null);
        AppState.tobii.coordinateSpace = bridgeField(payload, "coordinateSpace", "coordinate_space") || null;
        return;
      }
      if (payload.type === "authenticated") {
        AppState.tobii.providerMode = bridgeField(payload, "provider", "provider") || AppState.tobii.providerMode;
        return;
      }
      if (payload.type === "gaze") recordTobiiSample(payload);
    }

    function handleTobiiBridgeMessage(event) {
      try {
        handleTobiiPayload(JSON.parse(event.data));
      } catch (error) { /* Ignore malformed messages from a nonconforming bridge. */ }
    }

    function notifyTobiiDisconnected(reason) {
      for (const listener of [...AppState.tobii.disconnectListeners]) {
        try { listener(reason); } catch (error) { /* A trial listener must not break reconnection. */ }
      }
    }

    function bindInjectedTobiiClient(client) {
      if (!client || AppState.tobii.injectedClientBound) return;
      AppState.tobii.injectedClientBound = true;
      client.addEventListener("gaze", (event) => handleTobiiPayload(event.detail));
      client.addEventListener("status", (event) => handleTobiiPayload(event.detail));
      client.addEventListener("ready", (event) => {
        AppState.tobii.connected = true;
        AppState.tobii.status = "connected";
        handleTobiiPayload(event.detail);
      });
      client.addEventListener("error", (event) => {
        AppState.tobii.lastError = event.detail && event.detail.message
          ? event.detail.message
          : "The local Tobii Bridge reported an error.";
      });
      client.addEventListener("close", () => {
        const wasConnected = AppState.tobii.connected;
        AppState.tobii.connected = false;
        AppState.tobii.status = "disconnected";
        if (wasConnected) notifyTobiiDisconnected("The Tobii Bridge connection was lost.");
      });
    }

    function withConnectionTimeout(promise, timeoutMs) {
      return Promise.race([
        promise,
        new Promise((_, reject) => window.setTimeout(
          () => reject(new Error("Connection timed out. Start the Tobii Bridge and try again.")),
          timeoutMs
        ))
      ]);
    }

    function connectTobiiBridge(timeoutMs = 4000) {
      if (!AppState.tobii.configured || (!injectedBridgeClient && !AppState.tobii.endpoint)) {
        AppState.tobii.lastError = "No bridge launch token was provided.";
        return Promise.resolve(false);
      }
      if (injectedBridgeClient) {
        if (AppState.tobii.connectPromise) return AppState.tobii.connectPromise;
        bindInjectedTobiiClient(injectedBridgeClient);
        AppState.tobii.status = "connecting";
        AppState.tobii.lastError = null;
        AppState.tobii.connectPromise = (async () => {
          try {
            await withConnectionTimeout(injectedBridgeClient.ready(), timeoutMs);
            AppState.tobii.socket = injectedBridgeClient.socket || null;
            await withConnectionTimeout(injectedBridgeClient.start(), timeoutMs);
            try { await withConnectionTimeout(injectedBridgeClient.refreshStatus(), timeoutMs); } catch (error) { /* Status is diagnostic only. */ }
            AppState.tobii.connected = true;
            AppState.tobii.status = "connected";
            return true;
          } catch (error) {
            AppState.tobii.connected = false;
            AppState.tobii.status = "disconnected";
            AppState.tobii.lastError = error && error.message ? error.message : "Could not start the Tobii Bridge provider.";
            return false;
          } finally {
            AppState.tobii.connectPromise = null;
          }
        })();
        return AppState.tobii.connectPromise;
      }
      if (AppState.tobii.socket && AppState.tobii.socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
      if (AppState.tobii.connectPromise) return AppState.tobii.connectPromise;
      AppState.tobii.status = "connecting";
      AppState.tobii.lastError = null;
      AppState.tobii.connectPromise = new Promise((resolve) => {
        let settled = false;
        let socket;
        let timer = null;
        const finish = (connected, error = null) => {
          if (settled) return;
          settled = true;
          if (timer !== null) window.clearTimeout(timer);
          AppState.tobii.connectPromise = null;
          AppState.tobii.connected = connected;
          AppState.tobii.status = connected ? "connected" : "disconnected";
          AppState.tobii.lastError = error;
          resolve(connected);
        };
        try {
          socket = new WebSocket(AppState.tobii.endpoint);
          AppState.tobii.socket = socket;
        } catch (error) {
          finish(false, "The local WebSocket address is invalid.");
          return;
        }
        timer = window.setTimeout(() => {
          try { socket.close(); } catch (error) { /* Ignore close errors after timeout. */ }
          finish(false, "Connection timed out. Start the Tobii Bridge and try again.");
        }, timeoutMs);
        socket.addEventListener("open", () => finish(true));
        socket.addEventListener("message", handleTobiiBridgeMessage);
        socket.addEventListener("error", () => finish(false, "Could not connect to the local Tobii Bridge."));
        socket.addEventListener("close", () => {
          const wasConnected = AppState.tobii.connected;
          AppState.tobii.connected = false;
          AppState.tobii.status = "disconnected";
          AppState.tobii.socket = null;
          if (!settled) finish(false, "The local Tobii Bridge closed the connection.");
          if (wasConnected) notifyTobiiDisconnected("The Tobii Bridge connection was lost.");
        });
      });
      return AppState.tobii.connectPromise;
    }

    function disconnectTobiiBridge() {
      if (injectedBridgeClient) {
        if (injectedBridgeClient.connectionState === "ready") {
          void injectedBridgeClient.stop().catch((error) => {
            AppState.tobii.lastError = error && error.message ? error.message : "Could not stop the Tobii Bridge provider.";
          });
        }
        AppState.tobii.connected = injectedBridgeClient.connectionState === "ready";
        AppState.tobii.status = AppState.tobii.connected ? "connected" : "disconnected";
        return;
      }
      const socket = AppState.tobii.socket;
      AppState.tobii.connected = false;
      AppState.tobii.status = "disconnected";
      AppState.tobii.socket = null;
      if (socket) {
        try { socket.close(1000, "Eye tracking disabled"); } catch (error) { /* Already closed. */ }
      }
    }

    function beginTobiiTrial(sessionId) {
      AppState.tobii.activeTrial = {
        sessionId,
        startedPerformance: performance.now(),
        samples: [],
        lastAcceptedClock: null,
        downsampled: 0,
        overflow: 0,
        lastSampleTsUs: null,
        totalBlinkMs: 0,
        totalValidMs: 0,
        totalInThreshMs: 0,
        synchronousRecords: [],
        onSample: null
      };
    }

    function finishTobiiTrial(sessionId) {
      const active = AppState.tobii.activeTrial;
      AppState.tobii.activeTrial = null;
      if (!active || active.sessionId !== sessionId) {
        return { samples: [], downsampled: 0, overflow: 0, synchronousRecords: [], totalBlinkMs: 0, totalValidMs: 0, totalInThreshMs: 0, accuracyRate: 0 };
      }
      const validMs = active.totalValidMs || 0;
      const inThreshMs = active.totalInThreshMs || 0;
      const accRate = validMs > 0 ? round((inThreshMs / validMs) * 100, 2) : 0;
      return {
        samples: active.samples,
        downsampled: active.downsampled,
        overflow: active.overflow,
        synchronousRecords: active.synchronousRecords || [],
        totalBlinkMs: round(active.totalBlinkMs || 0, 2),
        totalValidMs: round(validMs, 2),
        totalInThreshMs: round(inThreshMs, 2),
        accuracyRate: accRate
      };
    }

    async function setEyeTrackingSource(source) {
      const nextSource = [EYE_SOURCE_WEBGAZER, EYE_SOURCE_TOBII].includes(source) ? source : EYE_SOURCE_OFF;
      if (nextSource !== EYE_SOURCE_WEBGAZER && (AppState.eyeTracking.enabled || AppState.eyeTracking.initialized)) {
        await stopEyeTrackingRuntime();
      }
      if (nextSource !== EYE_SOURCE_TOBII) disconnectTobiiBridge();
      AppState.eyeTracking.source = nextSource;
      AppState.eyeTracking.enabled = nextSource === EYE_SOURCE_WEBGAZER;
      if (nextSource === EYE_SOURCE_WEBGAZER) {
        AppState.eyeTracking.calibrationRequested = !AppState.eyeTracking.calibrated;
      }
      if (nextSource === EYE_SOURCE_TOBII) return connectTobiiBridge();
      return true;
    }

    function openDialog(dialog) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }

    function closeDialog(dialog) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }

    function calibrationFields(values = {}) {
      const value = (key) => values[key] ?? "";
      return `
        <div class="field-grid">
          <div class="field">
            <label for="screen-width-cm">Physical screen width</label>
            <div class="input-wrap">
              <input id="screen-width-cm" name="screenWidthCm" data-label="Physical screen width" type="number" min="0" step="any" inputmode="decimal" value="${value("screenWidthCm")}" placeholder="e.g. 53.1" required>
              <span class="unit">cm</span>
            </div>
            <p class="field-hint">Width of the visible display area</p>
          </div>
          <div class="field">
            <label for="screen-height-cm">Physical screen height</label>
            <div class="input-wrap">
              <input id="screen-height-cm" name="screenHeightCm" data-label="Physical screen height" type="number" min="0" step="any" inputmode="decimal" value="${value("screenHeightCm")}" placeholder="e.g. 29.9" required>
              <span class="unit">cm</span>
            </div>
            <p class="field-hint">Height of the visible display area</p>
          </div>
          <div class="field">
            <label for="viewing-distance-cm">Viewing distance</label>
            <div class="input-wrap">
              <input id="viewing-distance-cm" name="viewingDistanceCm" data-label="Viewing distance" type="number" min="0" step="any" inputmode="decimal" value="${value("viewingDistanceCm")}" placeholder="e.g. 60" required>
              <span class="unit">cm</span>
            </div>
            <p class="field-hint">Distance from the eyes to the screen center</p>
          </div>
        </div>`;
    }

    function calibrationMetricsMarkup(calibration) {
      if (!calibration) {
        return `<div class="calibration-placeholder">Enter all three measurements to calculate the screen visual angle and pixel conversion.</div>`;
      }
      const oneDegree = stimulusPixels(60, calibration, {
        width: calibration.screenWidthPx,
        height: calibration.screenHeightPx
      });
      const mismatch = calibration.aspectMismatchPercent > 3
        ? `<p class="calibration-warning">The physical aspect ratio differs from the detected resolution by ${formatNumber(calibration.aspectMismatchPercent, 1)}%. Check the measurements and confirm that this is the correct display.</p>`
        : "";
      return `
        <div class="metric-list">
          <div class="metric"><span>Detected resolution<br>CSS pixels</span><strong>${calibration.screenWidthPx} × ${calibration.screenHeightPx}</strong></div>
          <div class="metric"><span>Horizontal visual angle</span><strong class="accent">${formatNumber(calibration.horizontalArcmin, 0)} arcmin</strong></div>
          <div class="metric"><span>Vertical visual angle</span><strong class="accent">${formatNumber(calibration.verticalArcmin, 0)} arcmin</strong></div>
          <div class="metric"><span>Target size at 1°</span><strong>${formatNumber(oneDegree.width, 1)} × ${formatNumber(oneDegree.height, 1)} px</strong></div>
        </div>
        ${mismatch}`;
    }

    function bindCalibrationPreview(form, output) {
      const update = () => {
        const result = readPositiveNumbers(form, ["screenWidthCm", "screenHeightCm", "viewingDistanceCm"]);
        output.innerHTML = result.errors.length ? calibrationMetricsMarkup(null) : calibrationMetricsMarkup(createCalibration(result.values));
      };
      form.addEventListener("input", update);
      update();
    }

    function appTopbar() {
      return `
        <header class="topbar">
          <div class="brand">OCULOMOTOR TRAINING</div>
          <div class="patient-notice">此訓練檔案僅提供 ${PATIENT_NAME} 視覺復能使用，請勿外流</div>
        </header>`;
    }

    class CalibrationPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement) {
        displayElement.innerHTML = `
          <section class="app-page">
            <div class="app-shell">
              ${appTopbar()}
              <p class="eyebrow">Initial calibration</p>
              <h1>Screen calibration</h1>
              <p class="lede">Seat the participant directly in front of the screen with their eyes aligned to its center. These measurements convert visual angle settings into CSS pixels.</p>
              <div class="setup-layout">
                <section class="panel form-panel">
                  <div class="panel-heading">
                    <div><h2>Display settings</h2><p>Measure the display currently in use.</p></div>
                  </div>
                  <form id="calibration-form">
                    <div class="field">
                      <label for="initial-subject-id">受試者 ID / 編號 (Subject ID)</label>
                      <div class="input-wrap">
                        <input id="initial-subject-id" name="subjectId" type="text" value="${escapeHtml(subjectId || '')}" placeholder="請輸入受試者編號 (例如 P001、A01)..." autocomplete="off" />
                      </div>
                      <p class="field-hint">輸入受試者代號，將自動同步記錄於每次測驗生成的 CSV 報告中</p>
                    </div>
                    ${calibrationFields(AppState.calibration || {})}
                    <div class="field">
                      <label for="initial-eye-tracking-source">Eye-tracking source</label>
                      <select id="initial-eye-tracking-source" name="eyeTrackingSource">
                        <option value="off" selected>Off</option>
                        <option value="webgazer" ${AppState.eyeTracking.available ? "" : "disabled"}>WebGazer (camera)</option>
                        <option value="tobii" ${AppState.tobii.configured ? "" : "disabled"}>Tobii Eye Tracker Bridge</option>
                      </select>
                    </div>
                    <p class="option-note">WebGazer requests camera access and runs a nine-point calibration before its first tracked session. Tobii tracking requires this page to be launched by the local bridge and hardware calibration to be completed in Tobii Experience.</p>
                    <label class="option-row" for="initial-tobii-calibrated">
                      <input id="initial-tobii-calibrated" name="tobiiCalibrated" type="checkbox" disabled>
                      <span>I confirm that this participant was calibrated in Tobii Experience</span>
                    </label>
                    <p id="calibration-error" class="form-error" role="alert"></p>
                    <div class="form-actions">
                      <p class="safety-note">Set browser zoom to 100%. Press ESC immediately if the participant feels dizzy or uncomfortable.</p>
                      <button class="primary-button" type="submit">Save and continue</button>
                    </div>
                  </form>
                </section>
                <aside class="panel metrics-panel" aria-live="polite">
                  <div class="panel-heading">
                    <div><h2>Calculated values</h2><p>Visual angle is shown in arcminutes.</p></div>
                  </div>
                  <div id="calibration-output"></div>
                </aside>
              </div>
            </div>
          </section>`;

        const form = displayElement.querySelector("#calibration-form");
        const output = displayElement.querySelector("#calibration-output");
        const error = displayElement.querySelector("#calibration-error");
        const initialEyeSource = form.elements.namedItem("eyeTrackingSource");
        const initialTobiiCalibrated = form.elements.namedItem("tobiiCalibrated");
        const initialSubjInput = form.elements.namedItem("subjectId");
        if (initialSubjInput) {
          initialSubjInput.addEventListener("input", (e) => {
            const val = e.target.value.trim();
            if (val) updateSubjectId(val, false);
          });
          initialSubjInput.addEventListener("change", (e) => {
            const val = e.target.value.trim();
            if (val) {
              updateSubjectId(val, false);
            } else {
              const fallback = updateSubjectId("", true);
              initialSubjInput.value = fallback;
            }
          });
        }
        const syncInitialEyeSource = () => {
          const tobiiSelected = initialEyeSource.value === EYE_SOURCE_TOBII;
          initialTobiiCalibrated.disabled = !tobiiSelected;
          if (!tobiiSelected) initialTobiiCalibrated.checked = false;
        };
        initialEyeSource.addEventListener("change", syncInitialEyeSource);
        syncInitialEyeSource();
        bindCalibrationPreview(form, output);

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const customSubj = form.elements.namedItem("subjectId")?.value;
          if (customSubj && customSubj.trim()) updateSubjectId(customSubj.trim(), false);
          const result = readPositiveNumbers(form, ["screenWidthCm", "screenHeightCm", "viewingDistanceCm"]);
          if (result.errors.length) {
            setError(error, `Enter a value greater than 0 for: ${result.errors.join(", ")}.`);
            return;
          }
          const eyeTrackingSource = String(form.elements.namedItem("eyeTrackingSource")?.value || EYE_SOURCE_OFF);
          if (eyeTrackingSource === EYE_SOURCE_WEBGAZER && !AppState.eyeTracking.available) {
            setError(error, "WebGazer is unavailable. Connect to the internet and reload, or continue without eye tracking.");
            return;
          }
          if (eyeTrackingSource === EYE_SOURCE_TOBII && !AppState.tobii.configured) {
            setError(error, "Launch this page with Oculomotor Tobii Bridge before selecting Tobii tracking.");
            return;
          }
          if (eyeTrackingSource === EYE_SOURCE_TOBII && !initialTobiiCalibrated.checked) {
            setError(error, "Confirm calibration in Tobii Experience before enabling Tobii tracking.");
            return;
          }
          AppState.calibration = createCalibration(result.values);
          saveDisplaySettings(AppState.calibration);
          AppState.tobii.hardwareCalibrationConfirmed = eyeTrackingSource === EYE_SOURCE_TOBII && initialTobiiCalibrated.checked;
          await setEyeTrackingSource(eyeTrackingSource);
          AppState.eyeTracking.calibrationRequested = eyeTrackingSource === EYE_SOURCE_WEBGAZER;
          this.jsPsych.finishTrial({
            action: "calibration_saved",
            screen_width_cm: AppState.calibration.screenWidthCm,
            screen_height_cm: AppState.calibration.screenHeightCm,
            viewing_distance_cm: AppState.calibration.viewingDistanceCm,
            horizontal_arcmin: round(AppState.calibration.horizontalArcmin, 3),
            vertical_arcmin: round(AppState.calibration.verticalArcmin, 3),
            screen_width_px: AppState.calibration.screenWidthPx,
            screen_height_px: AppState.calibration.screenHeightPx,
            eye_tracking_source: eyeTrackingSource,
            webgazer_enabled: eyeTrackingSource === EYE_SOURCE_WEBGAZER,
            tobii_bridge_connected: eyeTrackingSource === EYE_SOURCE_TOBII && AppState.tobii.connected
          });
        });
      }
    }

    CalibrationPlugin.info = {
      name: "global-calibration",
      version: "1.0.0",
      parameters: {},
      data: {
        action: { type: ParameterType.STRING },
        screen_width_cm: { type: ParameterType.FLOAT },
        screen_height_cm: { type: ParameterType.FLOAT },
        viewing_distance_cm: { type: ParameterType.FLOAT },
        horizontal_arcmin: { type: ParameterType.FLOAT },
        vertical_arcmin: { type: ParameterType.FLOAT },
        eye_tracking_source: { type: ParameterType.STRING },
        webgazer_enabled: { type: ParameterType.BOOL },
        tobii_bridge_connected: { type: ParameterType.BOOL }
      }
    };

    function subjectIdBar(currentId) {
      return `
        <div class="subject-id-bar">
          <div class="subject-id-label-group">
            <label for="subject-id-input" class="subject-id-title">受試者 ID / 編號 (Subject ID)</label>
            <span class="subject-id-subtitle">輸入受試者代號，將自動同步記錄於每次測驗生成的 CSV 報告中</span>
          </div>
          <div class="subject-id-input-group">
            <input type="text" id="subject-id-input" class="subject-id-input" value="${escapeHtml(currentId || '')}" placeholder="請輸入受試者編號 (例如 P001、A01)..." autocomplete="off" />
            <button type="button" id="subject-id-refresh-btn" class="secondary-button subject-id-refresh-btn" title="隨機產生新代號">隨機產生</button>
          </div>
        </div>`;
    }

    function calibrationStrip(calibration) {
      return `
        <div class="calibration-strip">
          <div class="strip-cell"><span>Display size</span><strong>${calibration.screenWidthCm} × ${calibration.screenHeightCm} cm</strong></div>
          <div class="strip-cell"><span>Viewing distance</span><strong>${calibration.viewingDistanceCm} cm</strong></div>
          <div class="strip-cell"><span>Horizontal angle</span><strong>${formatNumber(calibration.horizontalArcmin, 0)} arcmin</strong></div>
          <div class="strip-cell"><span>Vertical angle</span><strong>${formatNumber(calibration.verticalArcmin, 0)} arcmin</strong></div>
        </div>`;
    }

    function moduleCards() {
      return Object.entries(MODULES).map(([key, module]) => `
        <article class="module-card" data-module="${key}">
          <div class="module-top">
            <span class="module-code">${module.code}</span>
            <h2>${module.name}</h2>
            <p>${module.description}</p>
          </div>
          <button class="module-button" type="button" data-open-module="${key}" aria-label="Configure ${module.code} ${module.name}">Configure</button>
        </article>`).join("");
    }

    function uploadStatusText() {
      if (AppState.upload.status === "uploaded") return "DataPipe: uploaded to OSF";
      if (AppState.upload.status === "uploading") return "DataPipe: uploading…";
      if (AppState.upload.status === "queued" || AppState.upload.pendingCount > 0) {
        const detail = AppState.upload.lastError ? ` (${AppState.upload.lastError})` : "";
        return `DataPipe: ${AppState.upload.pendingCount || 1} local file${AppState.upload.pendingCount === 1 ? "" : "s"} waiting to retry${detail}`;
      }
      return "DataPipe: no pending upload";
    }

    function refreshUploadStatus() {
      const output = document.querySelector("[data-upload-status]");
      if (output) output.textContent = uploadStatusText();
    }

        function sessionBanner(session) {
      if (!session) return "";
      const completed = ["duration_complete", "evaluation_complete"].includes(session.end_reason);
      const reasonLabels = {
        duration_complete: "測驗正常完成 (Duration complete)",
        evaluation_complete: "評估輪數完成 (Evaluation complete)",
        escape: "使用者手動按 ESC 結束",
        fullscreen_exit: "退出全螢幕中止",
        visibility_hidden: "切換視窗中止",
        viewport_changed: "視窗解析度改變中止",
        invalid_geometry: "目標超出當前視窗範圍",
        eye_tracker_disconnected: "眼動儀連線中斷",
        eye_tracker_unavailable: "眼動儀未就緒",
        fullscreen_required: "眼動訓練需要進入全螢幕"
      };
      const module = MODULES[session.module] || { code: session.module };
      const acc = session.accuracy_rate !== undefined ? `${session.accuracy_rate}%` : "-";
      const inSec = session.in_threshold_sec !== undefined ? `${session.in_threshold_sec}s` : "-";
      const validSec = session.valid_sec !== undefined ? `${session.valid_sec}s` : "-";
      return `
        <div class="session-banner ${completed ? "" : "is-aborted"}">
          <div class="session-copy">
            <div>
              <strong>${module.code} ${completed ? "測驗完成" : "測驗中斷"} · 眼動正確率：<span style="color:var(--lime, #63e6ff); font-size:1.15em; font-weight:900;">${acc}</span></strong>
              <span>${reasonLabels[session.end_reason] || session.end_reason} · 在標時長：<strong>${inSec}</strong> / 有效時長：<strong>${validSec}</strong> · 閾值：${session.threshold_deg || 1.5}°</span>
              <span style="color:var(--muted, #888); font-size:12px;">單一 CSV 報表已自動輸出至 Data/ 資料夾</span>
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-shrink:0;">
            <button class="ghost-button" type="button" data-export-session>Export JSON</button>
            <button class="ghost-button" type="button" data-export-csv>Export CSV</button>
          </div>
        </div>`;
    }

    function modeOptions(selected) {
      return [
        [EVALUATION, "Evaluation"],
        [PREDICTABLE, "Predictable"],
        [RANDOM, "Random"]
      ].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
    }

    function numberField({ id, name, label, value, unit, hint, step = "any" }) {
      return `
        <div class="field">
          <label for="${id}">${label}</label>
          <div class="input-wrap">
            <input id="${id}" name="${name}" data-label="${label}" type="number" min="0" step="any" inputmode="decimal" value="${value}" required>
            <span class="unit">${unit}</span>
          </div>
          <p class="field-hint">${hint}</p>
        </div>`;
    }

    function moduleFormFields(moduleKey, settings) {
      const isVor = moduleKey === "vor";
      const currentArcmin = Number(settings.ballArcmin) || (settings.ballArcsec ? Number(settings.ballArcsec) / 60 : 60);
      const currentDeg = (currentArcmin / 60).toFixed(2);
      const stimType = settings.stimulusType || "white_dot";
      const currentDirs = Array.isArray(settings.directions) && settings.directions.length > 0
        ? settings.directions
        : [...ALL_DIRECTIONS];

      // 1. 測驗模式 (Test mode)
      const mode = isVor ? "" : `
        <div class="field span-all">
          <label for="module-mode">測驗模式 (Test mode)</label>
          <select id="module-mode" name="mode" required>${modeOptions(settings.mode)}</select>
          <p id="mode-hint" class="field-hint"></p>
        </div>`;

      // 2. 刺激物種類 (Stimulus Type)
      const stimField = isVor ? "" : `
        <div class="field span-all" style="margin-top: 2px;">
          <label class="field-label" style="display:block; margin-bottom:6px;">刺激種類 (Stimulus Type)</label>
          <input type="hidden" name="stimulusType" id="module-stimulus-type" value="${stimType}">
          <div class="training-option-grid training-option-grid-three" id="stimulus-type-grid">
            <button type="button" class="training-option ${stimType === 'white_dot' ? 'active' : ''}" data-stim-type="white_dot">
              <span class="training-option-title">White dot</span>
              <span class="training-option-meta">標準白點 (實心純白)</span>
            </button>
            <button type="button" class="training-option ${stimType === 'red_in_white' ? 'active' : ''}" data-stim-type="red_in_white">
              <span class="training-option-title">Red in White</span>
              <span class="training-option-meta">白底紅心 (內嵌紅點)</span>
            </button>
            <button type="button" class="training-option ${stimType === 'numbers_dot' ? 'active' : ''}" data-stim-type="numbers_dot">
              <span class="training-option-title">Numbers dot</span>
              <span class="training-option-meta">數字變色球 (動態切換)</span>
            </button>
          </div>
        </div>`;

      // 3. 刺激物大小 (Target Size) - 以角分呈現，即時換算顯示度
      const sizeSlider = `
        <div class="field span-all" style="margin-top: 4px;">
          <div class="slider-card" style="margin-top: 0;">
            <div class="slider-card-header">
              <span class="slider-card-title">刺激物大小 (Target Size)</span>
              <span class="slider-value-pill" id="val-ball-size">${currentArcmin}' (${currentDeg}°)</span>
            </div>
            <input type="range" class="custom-range-slider" id="slider-ball-arcmin"
                   min="10" max="300" step="5" value="${currentArcmin}">
            <div class="slider-scale-labels">
              <span>10' (0.17°)</span>
              <span>60' (1.00°)</span>
              <span>120' (2.00°)</span>
              <span>300' (5.00°)</span>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="ball-arcmin">刺激物視角 (角分)</label>
          <div class="input-wrap">
            <input id="ball-arcmin" name="ballArcmin" data-label="刺激物視角 (角分)" type="number" min="1" max="600" step="1" inputmode="decimal" value="${currentArcmin}" required>
            <span class="unit">' (角分)</span>
          </div>
          <p class="field-hint">1° = 60 角分</p>
        </div>`;

      // 4. 命中距離閾值 (Distance Threshold) - 以視角呈現
      const currentThreshArcmin = Number(settings.distanceThresholdArcmin) || 90;
      const currentThreshDeg = (currentThreshArcmin / 60).toFixed(2);
      const thresholdSlider = `
        <div class="field span-all" style="margin-top: 4px;">
          <div class="slider-card" style="margin-top: 0;">
            <div class="slider-card-header">
              <span class="slider-card-title">命中距離閾值 (Distance Threshold)</span>
              <span class="slider-value-pill" id="val-threshold-size">${currentThreshArcmin}' (${currentThreshDeg}°)</span>
            </div>
            <input type="range" class="custom-range-slider" id="slider-threshold-arcmin"
                   min="30" max="360" step="5" value="${currentThreshArcmin}">
            <div class="slider-scale-labels">
              <span>30' (0.50°)</span>
              <span>90' (1.50°)</span>
              <span>180' (3.00°)</span>
              <span>360' (6.00°)</span>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="threshold-arcmin">距離閾值視角 (角分)</label>
          <div class="input-wrap">
            <input id="threshold-arcmin" name="distanceThresholdArcmin" data-label="距離閾值視角 (角分)" type="number" min="10" max="600" step="1" inputmode="decimal" value="${currentThreshArcmin}" required>
            <span class="unit">' (角分)</span>
          </div>
          <p class="field-hint">受試者注視點在此半徑範圍內判定為在標命中 (預設 1.5° = 90 角分)</p>
        </div>`;

      let paramFields = "";
      if (moduleKey === "vor") {
        paramFields = `${sizeSlider}${thresholdSlider}
          ${numberField({ id: "change-ms", name: "changeMs", label: "切換間隔 (Change interval)", value: settings.changeMs, unit: "ms", hint: "數字與顏色切換的時間間隔", step: "1" })}
          ${numberField({ id: "total-sec", name: "totalSec", label: "訓練總時長 (Total duration)", value: settings.totalSec, unit: "sec", hint: "時間到達即自動結束", step: "0.1" })}`;
      } else if (moduleKey === "saccade") {
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}
          ${numberField({ id: "dwell-ms", name: "dwellMs", label: "停留時間 (Target dwell time)", value: settings.dwellMs, unit: "ms", hint: "每個九宮格位置的停留顯示時間", step: "1" })}
          ${numberField({ id: "total-sec", name: "totalSec", label: "訓練總時長 (Total duration)", value: settings.totalSec, unit: "sec", hint: "評估模式下會自動忽略此項", step: "0.1" })}`;
      } else if (moduleKey === "pursuit") {
        const speed = numberField({
          id: "speed-arcmin", name: "speedArcminSec", label: "移動速度 (Target speed)", value: settings.speedArcminSec,
          unit: "arcmin/sec", hint: "目標直線移動之角速度", step: "0.1"
        });
        const total = numberField({
          id: "total-sec", name: "totalSec", label: "訓練總時長 (Total duration)", value: settings.totalSec,
          unit: "sec", hint: "評估模式下會自動忽略此項", step: "0.1"
        });
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}${speed}${total}`;
      } else if (moduleKey === "fixation") {
        const speed = numberField({
          id: "speed-arcmin", name: "speedArcminSec", label: "移動速度 (Target speed)", value: settings.speedArcminSec,
          unit: "arcmin/sec", hint: "移動至邊緣之速度", step: "0.1"
        });
        const hold = numberField({
          id: "hold-sec", name: "holdSec", label: "邊緣注視時間 (Edge hold time)", value: settings.holdSec,
          unit: "sec", hint: "到達邊緣後的停留注視時間", step: "0.1"
        });
        const total = numberField({
          id: "total-sec", name: "totalSec", label: "訓練總時長 (Total duration)", value: settings.totalSec,
          unit: "sec", hint: "評估模式下會自動忽略此項", step: "0.1"
        });
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}${speed}${hold}${total}`;
      }

      // 4. 方向選擇 (Directions)
      const directionsField = isVor ? "" : `
        <div class="field span-all" style="margin-top: 6px;">
          <input type="hidden" name="directions" id="module-directions" value='${JSON.stringify(currentDirs)}'>
          <div class="training-setting-header">
            <div>
              <label class="field-label" style="font-size:13.5px; font-weight:800; color:#fff; display:block; margin-bottom:2px;">刺激呈現方向 (Directions)</label>
              <p class="training-setting-description">按照空間九宮格方位排列，點擊各方位開關或點擊中央快速全選</p>
            </div>
            <span id="badge-directions" class="slider-value-pill">${currentDirs.length}/8 方向啟用</span>
          </div>
          <div class="training-direction-compass-grid" id="nine-grid-compass">
            ${NINE_GRID_SLOTS.map(slot => {
              if (slot.type === 'dir') {
                const isActive = currentDirs.includes(slot.key);
                return `
                  <button type="button" class="direction-btn ${isActive ? 'active' : ''}" data-axis-key="${slot.key}">
                    <span class="direction-btn-arrow">${slot.arrow}</span>
                    <span class="direction-btn-label">${slot.label}</span>
                  </button>`;
              } else {
                const isAllActive = currentDirs.length === 8;
                return `
                  <button type="button" class="direction-btn ${isAllActive ? 'active' : ''}" data-center-btn>
                    <span class="direction-btn-arrow" style="font-size:15px; font-weight:900; letter-spacing:0.04em;">ALL</span>
                    <span class="direction-btn-label">全選</span>
                  </button>`;
              }
            }).join("")}
          </div>
        </div>`;

      return `${paramFields}${directionsField}`;
    }

    function readModuleSettings(form, moduleKey) {
      const isVor = moduleKey === "vor";
      const fieldsByModule = {
        vor: ["ballArcmin", "changeMs", "totalSec"],
        pursuit: ["ballArcmin", "speedArcminSec", "totalSec"],
        saccade: ["ballArcmin", "dwellMs", "totalSec"],
        fixation: ["ballArcmin", "speedArcminSec", "holdSec", "totalSec"]
      };
      const result = readPositiveNumbers(form, fieldsByModule[moduleKey]);
      if (result.values.ballArcmin) {
        result.values.ballArcsec = result.values.ballArcmin * 60;
      }
      if (!isVor) {
        result.values.mode = form.elements.namedItem("mode")?.value || PREDICTABLE;
        result.values.stimulusType = form.elements.namedItem("stimulusType")?.value || "white_dot";
        try {
          const dirVal = form.elements.namedItem("directions")?.value;
          result.values.directions = dirVal ? JSON.parse(dirVal) : [...ALL_DIRECTIONS];
        } catch (_) {
          result.values.directions = [...ALL_DIRECTIONS];
        }
        if (!Array.isArray(result.values.directions) || result.values.directions.length === 0) {
          result.errors.push("刺激呈現方向 (請至少啟用一個方位)");
        }
      }
      return result;
    }

    function targetFitError(moduleKey, settings, calibration) {
      const screenPixels = currentScreenPixels();
      const ballArcmin = settings.ballArcmin || (settings.ballArcsec ? settings.ballArcsec / 60 : 60);
      const size = stimulusPixels(ballArcmin, calibration, screenPixels);
      if (moduleKey === "saccade" && (size.width > screenPixels.width / 3 || size.height > screenPixels.height / 3)) {
        return "The Saccade target must fit inside each grid cell. Reduce the target visual angle.";
      }
      if (size.width >= screenPixels.width || size.height >= screenPixels.height) {
        return "The target is too large for the available screen area. Reduce the target visual angle.";
      }
      return "";
    }

    function moduleDialogMarkup(moduleKey) {
      const module = MODULES[moduleKey];
      const settings = AppState.moduleSettings[moduleKey];
      return `
        <dialog id="module-dialog" aria-labelledby="module-dialog-title">
          <div class="dialog-header">
            <div><p class="eyebrow">${module.code} setup</p><h2 id="module-dialog-title">${module.name} settings</h2><p>${module.short} · 受試者 ID：<strong style="color:var(--text); font-weight:700;">${escapeHtml(subjectId || '-')}</strong></p></div>
            <button class="icon-button" type="button" data-close-dialog aria-label="Close">×</button>
          </div>
          <div class="dialog-body">
            <form id="module-form" data-module="${moduleKey}">
              <div class="field-grid">${moduleFormFields(moduleKey, settings)}</div>
              <div id="target-preview" class="target-preview" aria-live="polite"></div>
              <p id="module-error" class="form-error" role="alert"></p>
              <div class="dialog-actions">
                <button class="ghost-button" type="button" data-close-dialog>Cancel</button>
                <button class="primary-button" type="submit">Start</button>
              </div>
            </form>
          </div>
        </dialog>`;
    }

    function bindModuleDialogEvents(dialog, form, moduleKey) {
      const isVor = moduleKey === "vor";
      const initialSettings = AppState.moduleSettings[moduleKey] || {};
      let selectedDirs = Array.isArray(initialSettings.directions) && initialSettings.directions.length > 0
        ? [...initialSettings.directions]
        : [...ALL_DIRECTIONS];
      let currentStimType = initialSettings.stimulusType || "white_dot";

      // 1. 刺激種類切換
      if (!isVor) {
        const stimButtons = dialog.querySelectorAll(".training-option[data-stim-type]");
        stimButtons.forEach((btn) => {
          btn.addEventListener("click", () => {
            stimButtons.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentStimType = btn.dataset.stimType;
            const hiddenInput = form.querySelector("#module-stimulus-type");
            if (hiddenInput) hiddenInput.value = currentStimType;
            updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs });
          });
        });

        // 2. 九宮格方向選擇
        const compassGrid = dialog.querySelector("#nine-grid-compass");
        if (compassGrid) {
          const dirButtons = compassGrid.querySelectorAll(".direction-btn[data-axis-key]");
          const centerBtn = compassGrid.querySelector(".direction-btn[data-center-btn]");
          const badgeEl = dialog.querySelector("#badge-directions");

          const updateCompassUI = () => {
            dirButtons.forEach((btn) => {
              const key = btn.dataset.axisKey;
              btn.classList.toggle("active", selectedDirs.includes(key));
            });
            if (centerBtn) {
              centerBtn.classList.toggle("active", selectedDirs.length === 8);
            }
            if (badgeEl) {
              badgeEl.textContent = `${selectedDirs.length}/8 方向啟用`;
            }
            const hiddenInput = form.querySelector("#module-directions");
            if (hiddenInput) hiddenInput.value = JSON.stringify(selectedDirs);
            updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs });
          };

          dirButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
              const key = btn.dataset.axisKey;
              if (selectedDirs.includes(key)) {
                if (selectedDirs.length > 1) {
                  selectedDirs = selectedDirs.filter((k) => k !== key);
                }
              } else {
                selectedDirs = [...selectedDirs, key];
              }
              updateCompassUI();
            });
          });

          if (centerBtn) {
            centerBtn.addEventListener("click", () => {
              if (selectedDirs.length === 8) {
                selectedDirs = ["middleUp", "rightMiddle", "middleDown", "leftMiddle"];
              } else {
                selectedDirs = [...ALL_DIRECTIONS];
              }
              updateCompassUI();
            });
          }
        }
      }

      // 3. 刺激大小滑桿與輸入框雙向連動 (以角分呈現，即時換算顯示度)
      const sliderBall = dialog.querySelector("#slider-ball-arcmin");
      const inputBall = dialog.querySelector("#ball-arcmin");
      const pillBall = dialog.querySelector("#val-ball-size");

      const syncBallSize = (val) => {
        const num = Math.max(1, Math.min(600, Number(val) || 60));
        if (sliderBall && Number(sliderBall.value) !== num) sliderBall.value = num;
        if (inputBall && Number(inputBall.value) !== num) inputBall.value = num;
        if (pillBall) {
          const deg = (num / 60).toFixed(2);
          pillBall.textContent = `${num}' (${deg}°)`;
        }
        updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs });
      };

      if (sliderBall) {
        sliderBall.addEventListener("input", (e) => syncBallSize(e.target.value));
      }
      if (inputBall) {
        inputBall.addEventListener("input", (e) => syncBallSize(e.target.value));
      }

      // 4. 距離閾值滑桿與輸入框雙向連動 (以角分呈現，即時換算顯示度)
      const sliderThresh = dialog.querySelector("#slider-threshold-arcmin");
      const inputThresh = form.querySelector("#threshold-arcmin");
      const pillThresh = dialog.querySelector("#val-threshold-size");

      const syncThreshSize = (val) => {
        const num = Math.max(10, Math.min(600, Number(val) || 90));
        if (sliderThresh && Number(sliderThresh.value) !== num) sliderThresh.value = num;
        if (inputThresh && Number(inputThresh.value) !== num) inputThresh.value = num;
        if (pillThresh) {
          const deg = (num / 60).toFixed(2);
          pillThresh.textContent = `${num}' (${deg}°)`;
        }
      };

      if (sliderThresh) {
        sliderThresh.addEventListener("input", (e) => syncThreshSize(e.target.value));
      }
      if (inputThresh) {
        inputThresh.addEventListener("input", (e) => syncThreshSize(e.target.value));
      }

      form.addEventListener("input", () => updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs }));
      form.addEventListener("change", () => updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs }));
      updateModulePreview(form, moduleKey, { stimulusType: currentStimType, directions: selectedDirs });
    }

    function updateModulePreview(form, moduleKey, extra = {}) {
      const output = form.querySelector("#target-preview");
      const settings = readModuleSettings(form, moduleKey);
      if (settings.errors.length || !AppState.calibration) {
        output.innerHTML = `<span>Rendered target size</span><strong>Enter valid values</strong>`;
        return;
      }
      const arcmin = settings.values.ballArcmin || (settings.values.ballArcsec ? settings.values.ballArcsec / 60 : 60);
      const deg = arcmin / 60;
      const size = stimulusPixels(arcmin, AppState.calibration);
      const mode = settings.values.mode;
      const stimType = settings.values.stimulusType || extra.stimulusType || "white_dot";
      const dirs = settings.values.directions || extra.directions || ALL_DIRECTIONS;

      const stimNames = {
        white_dot: "White dot",
        red_in_white: "Red in White",
        numbers_dot: "Numbers dot"
      };

      let modeText = "";
      if (moduleKey === "vor") {
        modeText = `中央目標識別 · ${settings.values.changeMs} ms / 次`;
      } else {
        const stimLabel = stimNames[stimType] || stimType;
        const dirCountText = `${dirs.length}/8 方向啟用`;
        if (mode === EVALUATION) {
          modeText = moduleKey === "saccade"
            ? `評估模式 (${dirs.length} 方位序列) · ${stimLabel}`
            : `評估模式 (${dirs.length} 方向 × 2輪) · ${stimLabel}`;
        } else if (mode === PREDICTABLE) {
          modeText = `可預測模式 (${dirCountText}) · ${stimLabel}`;
        } else {
          modeText = `隨機模式 (${dirCountText}) · ${stimLabel}`;
        }
      }

      if (moduleKey === "saccade" && mode === EVALUATION) {
        modeText = `Evaluation (fixed ${SACCADE_SEQUENCE.length} targets; selected directions only) · ${stimLabel}`;
      }

      output.innerHTML = `
        <span>${modeText}<br>視角 ${arcmin}' (${deg.toFixed(2)}°) · 直徑 ${formatNumber(size.diameterCm, 3)} cm</span>
        <strong>${formatNumber(size.width, 1)} × ${formatNumber(size.height, 1)} px</strong>
      `;

      const modeHint = form.querySelector("#mode-hint");
      if (modeHint) {
        modeHint.textContent = mode === EVALUATION
          ? "Evaluation ends after the fixed sequence is complete."
          : "Total duration starts with the first displayed stimulus.";
      }
    }

    function requestFullscreenSafely() {
      const element = document.documentElement;
      try {
        if (typeof element.requestFullscreen === "function") {
          const result = element.requestFullscreen({ navigationUI: "hide" });
          return Promise.resolve(result)
            .then(() => Boolean(document.fullscreenElement))
            .catch(() => false);
        }
        if (typeof element.webkitRequestFullscreen === "function") {
          const result = element.webkitRequestFullscreen();
          return Promise.resolve(result)
            .then(() => Boolean(document.webkitFullscreenElement))
            .catch(() => false);
        }
      } catch (error) {
        return Promise.resolve(false);
      }
      return Promise.resolve(false);
    }

    function downloadJson(data, filename) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    class MenuPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement) {
        AppState.pending = null;
        let settled = false;
        displayElement.innerHTML = `
          <section class="app-page">
            <div class="app-shell">
              ${appTopbar()}
              <div class="menu-hero">
                <div><p class="eyebrow">Training modules</p><h1>Select a training module</h1><p class="lede">Configure the target size, timing, speed, and test mode before each session.</p></div>
                <div class="menu-actions">
                  <button class="secondary-button" type="button" data-open-help>Instructions</button>
                  <button class="secondary-button" type="button" data-open-calibration>Calibration</button>
                  <button class="secondary-button" type="button" data-open-eye-tracking>${eyeTrackingStatusText()}</button>
                </div>
              </div>
              ${subjectIdBar(subjectId)}
              ${calibrationStrip(AppState.calibration)}
              ${sessionBanner(AppState.lastSession)}
              <div class="module-grid">${moduleCards()}</div>
            </div>
          </section>
          <dialog id="help-dialog" aria-labelledby="help-title">
            <div class="dialog-header"><div><p class="eyebrow">Quick guide</p><h2 id="help-title">Instructions and timing</h2></div><button class="icon-button" type="button" data-close-help aria-label="Close">×</button></div>
            <div class="dialog-body help-content">
              <ol>
                <li>Set browser zoom to 100%. Seat the participant directly in front of the screen at the configured viewing distance.</li>
                <li>Select a module, enter the settings, and choose Start. The browser will enter fullscreen when permitted.</li>
                <li>Eye tracking is optional. WebGazer uses camera positioning and nine-point calibration. Tobii uses the hardware profile calibrated in Tobii Experience.</li>
                <li>The pointer is hidden during training. Press ESC at any time to stop and return to the menu.</li>
                <li>Evaluation follows a fixed sequence. Predictable and Random modes stop at the configured total duration.</li>
              </ol>
              <p class="help-callout">Visible timing is limited by the display refresh rate. The application uses performance.now() and requestAnimationFrame and records actual stimulus timing in the exported jsPsych data.</p>
            </div>
          </dialog>
          <dialog id="calibration-dialog" aria-labelledby="recalibration-title">
            <div class="dialog-header"><div><p class="eyebrow">Calibration</p><h2 id="recalibration-title">Update display calibration</h2></div><button class="icon-button" type="button" data-close-calibration aria-label="Close">×</button></div>
            <div class="dialog-body">
              <form id="recalibration-form">
                ${calibrationFields(AppState.calibration)}
                <div id="recalibration-output" style="margin-top:18px"></div>
                <p id="recalibration-error" class="form-error" role="alert"></p>
                <div class="dialog-actions"><button class="ghost-button" type="button" data-close-calibration>Cancel</button><button class="primary-button" type="submit">Save calibration</button></div>
              </form>
            </div>
          </dialog>
          <dialog id="eye-tracking-dialog" aria-labelledby="eye-tracking-title">
            <div class="dialog-header"><div><p class="eyebrow">Data source</p><h2 id="eye-tracking-title">Eye tracking</h2></div><button class="icon-button" type="button" data-close-eye-tracking aria-label="Close">×</button></div>
            <div class="dialog-body">
              <form id="eye-tracking-form">
                <div class="field">
                  <label for="eye-tracking-source">Eye-tracking source</label>
                  <select id="eye-tracking-source" name="eyeTrackingSource">
                    <option value="off" ${AppState.eyeTracking.source === EYE_SOURCE_OFF ? "selected" : ""}>Off</option>
                    <option value="webgazer" ${AppState.eyeTracking.source === EYE_SOURCE_WEBGAZER ? "selected" : ""} ${AppState.eyeTracking.available ? "" : "disabled"}>WebGazer (camera)</option>
                    <option value="tobii" ${AppState.eyeTracking.source === EYE_SOURCE_TOBII ? "selected" : ""} ${AppState.tobii.configured ? "" : "disabled"}>Tobii Eye Tracker Bridge</option>
                  </select>
                </div>
                <p id="eye-tracking-source-note" class="option-note"></p>
                <label class="option-row" for="webgazer-recalibrate">
                  <input id="webgazer-recalibrate" name="webgazerRecalibrate" type="checkbox" ${AppState.eyeTracking.calibrationRequested ? "checked" : ""}>
                  <span>Run WebGazer calibration before the next training session</span>
                </label>
                <label class="option-row" for="tobii-calibrated">
                  <input id="tobii-calibrated" name="tobiiCalibrated" type="checkbox" ${AppState.tobii.hardwareCalibrationConfirmed ? "checked" : ""}>
                  <span>I confirm that this participant was calibrated in Tobii Experience</span>
                </label>
                <p id="eye-tracking-status" class="option-note"></p>
                <p id="eye-tracking-error" class="form-error" role="alert"></p>
                <div class="dialog-actions"><button class="ghost-button" type="button" data-close-eye-tracking>Cancel</button><button class="primary-button" type="submit">Save settings</button></div>
              </form>
            </div>
          </dialog>`;

        const helpDialog = displayElement.querySelector("#help-dialog");
        const calibrationDialog = displayElement.querySelector("#calibration-dialog");
        const eyeTrackingDialog = displayElement.querySelector("#eye-tracking-dialog");
        const calibrationForm = displayElement.querySelector("#recalibration-form");
        const eyeTrackingForm = displayElement.querySelector("#eye-tracking-form");
        bindCalibrationPreview(calibrationForm, displayElement.querySelector("#recalibration-output"));

        displayElement.querySelector("[data-open-help]").addEventListener("click", () => openDialog(helpDialog));
        displayElement.querySelectorAll("[data-close-help]").forEach((button) => button.addEventListener("click", () => closeDialog(helpDialog)));
        displayElement.querySelector("[data-open-calibration]").addEventListener("click", () => openDialog(calibrationDialog));
        displayElement.querySelectorAll("[data-close-calibration]").forEach((button) => button.addEventListener("click", () => closeDialog(calibrationDialog)));
        displayElement.querySelector("[data-open-eye-tracking]").addEventListener("click", () => openDialog(eyeTrackingDialog));
        displayElement.querySelectorAll("[data-close-eye-tracking]").forEach((button) => button.addEventListener("click", () => closeDialog(eyeTrackingDialog)));

        const subjectInput = displayElement.querySelector("#subject-id-input");
        const refreshBtn = displayElement.querySelector("#subject-id-refresh-btn");
        if (subjectInput) {
          subjectInput.addEventListener("input", (e) => {
            const val = e.target.value.trim();
            if (val) {
              updateSubjectId(val, false);
            }
          });
          subjectInput.addEventListener("change", (e) => {
            const val = e.target.value.trim();
            if (val) {
              updateSubjectId(val, false);
            } else {
              const fallback = updateSubjectId("", true);
              subjectInput.value = fallback;
            }
          });
        }
        if (refreshBtn) {
          refreshBtn.addEventListener("click", () => {
            const newRandomId = "SUBJ_" + Math.random().toString(36).slice(2, 8).toUpperCase();
            updateSubjectId(newRandomId, true);
            if (subjectInput) subjectInput.value = newRandomId;
          });
        }

        const eyeTrackingSourceInput = eyeTrackingForm.elements.namedItem("eyeTrackingSource");
        const eyeTrackingRecalibrateInput = eyeTrackingForm.elements.namedItem("webgazerRecalibrate");
        const tobiiCalibratedInput = eyeTrackingForm.elements.namedItem("tobiiCalibrated");
        const eyeTrackingStatus = displayElement.querySelector("#eye-tracking-status");
        const eyeTrackingSourceNote = displayElement.querySelector("#eye-tracking-source-note");
        const syncEyeTrackingForm = () => {
          const source = String(eyeTrackingSourceInput.value || EYE_SOURCE_OFF);
          const webgazerSelected = source === EYE_SOURCE_WEBGAZER;
          const tobiiSelected = source === EYE_SOURCE_TOBII;
          const calibrationIsRequired = webgazerSelected && !AppState.eyeTracking.calibrated;
          eyeTrackingRecalibrateInput.disabled = !webgazerSelected || calibrationIsRequired;
          tobiiCalibratedInput.disabled = !tobiiSelected;
          if (!webgazerSelected) eyeTrackingRecalibrateInput.checked = false;
          if (calibrationIsRequired) eyeTrackingRecalibrateInput.checked = true;
          eyeTrackingSourceNote.textContent = webgazerSelected
            ? "Camera video is processed locally. Only gaze coordinates are added to the current session data."
            : tobiiSelected
              ? "Tobii calibration is performed in Tobii Experience, not in this browser. Gaze samples are buffered only during each training trial."
              : "No gaze source will be used.";
          eyeTrackingStatus.textContent = source === EYE_SOURCE_OFF
            ? "No camera access or gaze data will be used."
            : webgazerSelected && calibrationIsRequired
              ? "Calibration is required before the first tracked training session."
              : webgazerSelected && AppState.eyeTracking.calibratedAt
                ? `Current calibration: ${new Date(AppState.eyeTracking.calibratedAt).toLocaleString("en-US")}.`
                : webgazerSelected
                  ? "The current WebGazer calibration will be used."
                  : tobiiStatusText();
        };
        eyeTrackingSourceInput.addEventListener("change", syncEyeTrackingForm);
        syncEyeTrackingForm();

        eyeTrackingForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          const source = String(eyeTrackingSourceInput.value || EYE_SOURCE_OFF);
          if (source === EYE_SOURCE_WEBGAZER && !AppState.eyeTracking.available) {
            setError(displayElement.querySelector("#eye-tracking-error"), "WebGazer is unavailable. Connect to the internet and reload the page.");
            return;
          }
          if (source === EYE_SOURCE_TOBII && !AppState.tobii.configured) {
            setError(displayElement.querySelector("#eye-tracking-error"), "Launch this page with Oculomotor Tobii Bridge first.");
            return;
          }
          if (source === EYE_SOURCE_TOBII && !tobiiCalibratedInput.checked) {
            setError(displayElement.querySelector("#eye-tracking-error"), "Confirm calibration in Tobii Experience before enabling Tobii tracking.");
            return;
          }
          AppState.tobii.hardwareCalibrationConfirmed = Boolean(tobiiCalibratedInput.checked);
          const sourceReady = await setEyeTrackingSource(source);
          if (source === EYE_SOURCE_TOBII && !sourceReady) {
            setError(displayElement.querySelector("#eye-tracking-error"), tobiiStatusText());
            syncEyeTrackingForm();
            return;
          }
          if (source === EYE_SOURCE_WEBGAZER) {
            AppState.eyeTracking.lastError = null;
            AppState.eyeTracking.calibrationRequested = (
              !AppState.eyeTracking.calibrated || Boolean(eyeTrackingRecalibrateInput.checked)
            );
          }
          displayElement.querySelector("[data-open-eye-tracking]").textContent = eyeTrackingStatusText();
          closeDialog(eyeTrackingDialog);
        });

        calibrationForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const result = readPositiveNumbers(calibrationForm, ["screenWidthCm", "screenHeightCm", "viewingDistanceCm"]);
          if (result.errors.length) {
            setError(displayElement.querySelector("#recalibration-error"), `Enter a value greater than 0 for: ${result.errors.join(", ")}.`);
            return;
          }
          if (settled) return;
          settled = true;
          AppState.calibration = createCalibration(result.values);
          saveDisplaySettings(AppState.calibration);
          this.jsPsych.finishTrial({ action: "calibration_updated", selected_module: null });
        });

        const exportButton = displayElement.querySelector("[data-export-session]");
        if (exportButton) {
          exportButton.addEventListener("click", () => {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            downloadJson(AppState.lastSession, `${subjectId}_eye-training-${AppState.lastSession.module}-${stamp}.json`);
          });
        }

        const exportCsvButton = displayElement.querySelector("[data-export-csv]");
        if (exportCsvButton) {
          exportCsvButton.addEventListener("click", () => {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const sid = AppState.lastSession && AppState.lastSession.session_id;
            const dataObj = sid ? window.jsPsychInstance.data.get().filter({ session_id: sid }) : window.jsPsychInstance.data.get();
            const csvData = dataObj.csv();
            const blob = new Blob([csvData], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${subjectId}_eye-training-${AppState.lastSession.module}-${stamp}.csv`;
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          });
        }

        displayElement.querySelectorAll("[data-open-module]").forEach((button) => {
          button.addEventListener("click", () => {
            const moduleKey = button.dataset.openModule;
            const existing = displayElement.querySelector("#module-dialog");
            if (existing) existing.remove();
            displayElement.insertAdjacentHTML("beforeend", moduleDialogMarkup(moduleKey));
            const dialog = displayElement.querySelector("#module-dialog");
            const form = dialog.querySelector("#module-form");
            const error = dialog.querySelector("#module-error");
            const closeButtons = dialog.querySelectorAll("[data-close-dialog]");
            closeButtons.forEach((closeButton) => closeButton.addEventListener("click", () => closeDialog(dialog)));
            bindModuleDialogEvents(dialog, form, moduleKey);
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              const result = readModuleSettings(form, moduleKey);
              if (result.errors.length) {
                setError(error, `Enter a value greater than 0 for: ${result.errors.join(", ")}.`);
                return;
              }
              const fitError = targetFitError(moduleKey, result.values, AppState.calibration);
              if (fitError) {
                setError(error, fitError);
                return;
              }
              if (AppState.eyeTracking.enabled && !AppState.eyeTracking.available) {
                setError(error, "Eye tracking is unavailable. Disable it in Eye tracking settings or reload while online.");
                return;
              }
              const eyeTrackingSource = AppState.eyeTracking.source;
              if (eyeTrackingSource === EYE_SOURCE_TOBII && !AppState.tobii.hardwareCalibrationConfirmed) {
                setError(error, "Open Eye tracking settings and confirm calibration in Tobii Experience first.");
                return;
              }
              if (settled) return;
              settled = true;
              AppState.moduleSettings[moduleKey] = { ...result.values };
              saveStoredModuleSettings(AppState.moduleSettings);
              const submitButton = form.querySelector("button[type='submit']");
              submitButton.disabled = true;
              submitButton.textContent = "Preparing…";
              setError(error, "");
              closeDialog(dialog);

              requestFullscreenSafely().then(async (fullscreenEntered) => {
                if (eyeTrackingSource === EYE_SOURCE_TOBII && !fullscreenEntered) {
                  settled = false;
                  submitButton.disabled = false;
                  submitButton.textContent = "Start";
                  setError(error, "Tobii tracking requires fullscreen. Allow fullscreen access and start again.");
                  openDialog(dialog);
                  return;
                }
                if (eyeTrackingSource === EYE_SOURCE_TOBII && !AppState.tobii.connected) {
                  const connected = await connectTobiiBridge();
                  if (!connected) {
                    await exitFullscreenSafely();
                    settled = false;
                    submitButton.disabled = false;
                    submitButton.textContent = "Start";
                    setError(error, tobiiStatusText());
                    openDialog(dialog);
                    return;
                  }
                }
                const sessionViewport = currentViewportSignature();
                if (AppState.eyeTracking.enabled && AppState.eyeTracking.calibrated &&
                    !viewportSignaturesMatch(AppState.eyeTracking.calibrationViewport, sessionViewport)) {
                  AppState.eyeTracking.calibrated = false;
                  AppState.eyeTracking.calibrationRequested = true;
                  AppState.eyeTracking.calibratedAt = null;
                  AppState.eyeTracking.calibrationViewport = null;
                }
                if (AppState.eyeTracking.enabled && !AppState.eyeTracking.calibrated) {
                  AppState.eyeTracking.calibrationRequested = true;
                }
                AppState.pending = {
                  module: moduleKey,
                  settings: { ...result.values },
                  calibration: { ...AppState.calibration },
                  fullscreenEntered,
                  setupViewport: sessionViewport,
                  eyeTrackingEnabled: eyeTrackingSource === EYE_SOURCE_WEBGAZER,
                  eyeTrackingSource
                };
                this.jsPsych.finishTrial({
                  action: "module_selected",
                  selected_module: moduleKey,
                  fullscreen_entered: fullscreenEntered,
                  eye_tracking_source: eyeTrackingSource,
                  webgazer_enabled: eyeTrackingSource === EYE_SOURCE_WEBGAZER,
                  webgazer_calibration_requested: eyeTrackingSource === EYE_SOURCE_WEBGAZER && AppState.eyeTracking.calibrationRequested,
                  tobii_bridge_connected: eyeTrackingSource === EYE_SOURCE_TOBII && AppState.tobii.connected
                });
              });
            });
            openDialog(dialog);
          });
        });
      }
    }

    MenuPlugin.info = {
      name: "training-menu",
      version: "1.0.0",
      parameters: {},
      data: {
        action: { type: ParameterType.STRING },
        selected_module: { type: ParameterType.STRING },
        fullscreen_entered: { type: ParameterType.BOOL },
        eye_tracking_source: { type: ParameterType.STRING },
        webgazer_enabled: { type: ParameterType.BOOL },
        webgazer_calibration_requested: { type: ParameterType.BOOL },
        tobii_bridge_connected: { type: ParameterType.BOOL }
      }
    };

    function fullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function exitFullscreenSafely() {
      try {
        if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
          return Promise.resolve(document.exitFullscreen()).catch(() => undefined);
        }
        if (document.webkitFullscreenElement && typeof document.webkitExitFullscreen === "function") {
          return Promise.resolve(document.webkitExitFullscreen()).catch(() => undefined);
        }
      } catch (error) {
        return Promise.resolve();
      }
      return Promise.resolve();
    }

    function edgePoint(direction, geometry) {
      const { viewportWidth: width, viewportHeight: height, targetWidth, targetHeight } = geometry;
      const left = targetWidth / 2;
      const right = width - targetWidth / 2;
      const top = targetHeight / 2;
      const bottom = height - targetHeight / 2;
      const centerX = width / 2;
      const centerY = height / 2;
      const points = {
        rightUp: { x: right, y: top },
        leftUp: { x: left, y: top },
        rightDown: { x: right, y: bottom },
        leftDown: { x: left, y: bottom },
        rightMiddle: { x: right, y: centerY },
        leftMiddle: { x: left, y: centerY },
        middleUp: { x: centerX, y: top },
        middleDown: { x: centerX, y: bottom }
      };
      return points[direction];
    }

    function gridPoint(direction, geometry) {
      const { viewportWidth: width, viewportHeight: height } = geometry;
      const xs = { left: width / 6, middle: width / 2, right: width * 5 / 6 };
      const ys = { up: height / 6, middle: height / 2, down: height * 5 / 6 };
      const points = {
        leftUp: { x: xs.left, y: ys.up },
        middleUp: { x: xs.middle, y: ys.up },
        rightUp: { x: xs.right, y: ys.up },
        leftMiddle: { x: xs.left, y: ys.middle },
        center: { x: xs.middle, y: ys.middle },
        rightMiddle: { x: xs.right, y: ys.middle },
        leftDown: { x: xs.left, y: ys.down },
        middleDown: { x: xs.middle, y: ys.down },
        rightDown: { x: xs.right, y: ys.down }
      };
      return points[direction];
    }

    function movementDurationMs(from, to, speedArcminSec, calibration, screenPixels) {
      const dxCm = (to.x - from.x) * calibration.screenWidthCm / screenPixels.width;
      const dyCm = (to.y - from.y) * calibration.screenHeightCm / screenPixels.height;
      const pathCm = Math.hypot(dxCm, dyCm);
      const cmPerArcminAtCenter = calibration.viewingDistanceCm * Math.tan(RAD_PER_ARCMIN);
      return pathCm / (speedArcminSec * cmPerArcminAtCenter) * 1000;
    }

    function makePicker(mode, sequence, evaluationRepetitions = 1, randomChoices = sequence) {
      const evaluationItems = Array.from({ length: evaluationRepetitions }, () => sequence).flat();
      const predictableStart = 0;
      let cursor = 0;
      return {
        predictableStart,
        evaluationTotal: mode === EVALUATION ? evaluationItems.length : null,
        next(currentKey = null, avoidRepeat = false) {
          if (mode === EVALUATION) return evaluationItems[cursor++];
          if (mode === PREDICTABLE) return sequence[(predictableStart + cursor++) % sequence.length];
          const candidates = avoidRepeat ? randomChoices.filter((key) => key !== currentKey) : randomChoices;
          const choices = candidates.length > 0 ? candidates : randomChoices;
          cursor += 1;
          return choices[Math.floor(Math.random() * choices.length)];
        }
      };
    }

    function buildSaccadeSequence(selectedDirs, mode) {
      const enabledDirections = [...new Set(
        selectedDirs.filter((direction) => ALL_DIRECTIONS.includes(direction))
      )];
      const availableDirections = enabledDirections.length > 0 ? enabledDirections : [...ALL_DIRECTIONS];
      const filteredSequence = SACCADE_SEQUENCE.filter((direction) => availableDirections.includes(direction));
      const baseSequence = filteredSequence.length >= 2 ? filteredSequence : availableDirections;

      // Evaluation used to finish after only four targets when just left and right
      // were enabled. Keep its fixed 24-target protocol while restricting every
      // target to the selected directions.
      if (mode !== EVALUATION) return baseSequence;
      return Array.from(
        { length: SACCADE_SEQUENCE.length },
        (_, index) => baseSequence[index % baseSequence.length]
      );
    }

    function contrastingText(hex) {
      const value = hex.replace("#", "");
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return (r * 299 + g * 587 + b * 114) / 1000 > 154 ? "#061018" : "#ffffff";
    }

    class OptionalWebGazerCameraPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement, trial, onLoad) {
        const extension = this.jsPsych.extensions.webgazer;
        const startedAt = performance.now();
        let finished = false;
        let faceTimer = null;
        let onLoadSent = false;

        const signalLoad = () => {
          if (onLoadSent) return;
          onLoadSent = true;
          if (typeof onLoad === "function") onLoad();
        };

        const clean = () => {
          if (faceTimer !== null) window.clearInterval(faceTimer);
          try { extension.pause(); } catch (error) { /* Continue cleanup. */ }
          try { extension.hideVideo(); } catch (error) { /* Continue cleanup. */ }
          try { extension.hidePredictions(); } catch (error) { /* Continue cleanup. */ }
        };

        const finish = (ready, error = null) => {
          if (finished) return;
          finished = true;
          clean();
          this.jsPsych.finishTrial({
            ready,
            error,
            load_time: Math.round(performance.now() - startedAt)
          });
        };

        const showCamera = () => {
          displayElement.innerHTML = `
            <section class="app-page">
              <div class="app-shell" style="max-width:760px">
                <p class="eyebrow">WebGazer setup</p>
                <h1>Camera positioning</h1>
                <p class="lede">Keep your head still and position your face until the camera guide indicates that tracking is ready. The next screen contains the calibration points.</p>
                <div class="webgazer-camera-actions">
                  <button id="webgazer-camera-continue" class="primary-button" type="button" disabled>Continue to calibration</button>
                  <button id="webgazer-camera-skip" class="secondary-button" type="button">Continue without eye tracking</button>
                </div>
              </div>
            </section>`;
          try { extension.showVideo(); } catch (error) { finish(false, "Camera preview could not be displayed."); return; }
          try { extension.resume(); } catch (error) { finish(false, "Eye tracking could not be resumed."); return; }
          const continueButton = displayElement.querySelector("#webgazer-camera-continue");
          const skipButton = displayElement.querySelector("#webgazer-camera-skip");
          const updateFaceState = () => {
            let detected = false;
            try { detected = Boolean(extension.faceDetected()); } catch (error) { detected = false; }
            continueButton.disabled = !detected;
          };
          continueButton.addEventListener("click", () => finish(true));
          skipButton.addEventListener("click", () => finish(false, "Skipped by the user."));
          updateFaceState();
          faceTimer = window.setInterval(updateFaceState, 200);
          signalLoad();
        };

        const showFailure = (error) => {
          const message = error && error.message ? error.message : String(error || "Camera access failed.");
          displayElement.innerHTML = `
            <section class="app-page">
              <div class="app-shell" style="max-width:760px">
                <p class="eyebrow">WebGazer setup</p>
                <h1>Eye tracking unavailable</h1>
                <p class="lede">The camera could not be initialized. You can continue this training session without eye tracking.</p>
                <div class="webgazer-camera-actions">
                  <button id="webgazer-camera-fallback" class="primary-button" type="button">Continue without eye tracking</button>
                </div>
              </div>
            </section>`;
          displayElement.querySelector("#webgazer-camera-fallback").addEventListener("click", () => finish(false, message));
          signalLoad();
        };

        const start = extension && extension.isInitialized()
          ? Promise.resolve()
          : extension && typeof extension.start === "function"
            ? extension.start()
            : Promise.reject(new Error("The jsPsych WebGazer extension is unavailable."));
        Promise.resolve(start).then(showCamera).catch(showFailure);
      }
    }

    OptionalWebGazerCameraPlugin.info = {
      name: "optional-webgazer-camera",
      version: "1.0.0",
      parameters: {},
      data: {
        ready: { type: ParameterType.BOOL },
        error: { type: ParameterType.STRING },
        load_time: { type: ParameterType.INT }
      }
    };

    const DIRECTION_CHINESE_LABELS = {
      rightUp: "右上",
      leftUp: "左上",
      rightDown: "右下",
      leftDown: "左下",
      middleUp: "上",
      middleDown: "下",
      leftMiddle: "左",
      rightMiddle: "右",
      center: "中央"
    };

    function csvEscape(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      return `"${str.replace(/"/g, '""')}"`;
    }

    function triggerFileDownload(filename, textContent) {
      try {
        const blob = new Blob(["\uFEFF" + textContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          if (link.parentNode) link.parentNode.removeChild(link);
          URL.revokeObjectURL(url);
        }, 1500);
      } catch (error) {
        console.error("Failed to download CSV:", error);
      }
    }

        function exportTrialCsvs(trialData) {
      const {
        sessionId,
        subjectId,
        moduleKey,
        settings,
        calibration,
        screenPixels,
        geometry,
        ballArcmin,
        ballArcsec,
        targetSize,
        stimulusType,
        selectedDirs,
        isTimed,
        sessionStart,
        endedAt,
        reason,
        completedTargets,
        normalFrameMedian,
        eyeTrackingSource,
        tobiiCapture
      } = trialData;

      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const isoDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const isoTime = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const moduleCode = (MODULES[moduleKey] && MODULES[moduleKey].code) ? MODULES[moduleKey].code : moduleKey.toUpperCase();
      const moduleName = (MODULES[moduleKey] && MODULES[moduleKey].name) || moduleKey;

      const thresholdArcmin = Number(settings.distanceThresholdArcmin) || 90;
      const thresholdDeg = (thresholdArcmin / 60).toFixed(2);
      const thresholdPx = round((thresholdArcmin / ballArcmin) * (geometry.targetWidth / 2), 1);
      const actualDurationMs = sessionStart === null ? 0 : endedAt - sessionStart;

      const totalValidMs = (tobiiCapture && tobiiCapture.totalValidMs) || 0;
      const totalInThreshMs = (tobiiCapture && tobiiCapture.totalInThreshMs) || 0;
      const totalBlinkMs = (tobiiCapture && tobiiCapture.totalBlinkMs) || 0;
      const accuracyRate = (tobiiCapture && tobiiCapture.accuracyRate !== undefined) ? tobiiCapture.accuracyRate : 0;
      const records = (tobiiCapture && tobiiCapture.synchronousRecords) || [];

      // 檔名：{受試者ID}_{測驗日期8碼}_{測驗時間6碼}_{模組代碼}_眼動記錄.csv
      const csvFilename = `${subjectId || "SUBJ"}_${dateStr}_${timeStr}_${moduleCode}_眼動記錄.csv`;

      const selectedDirectionLabelsChinese = (selectedDirs || []).map(
        (dirKey) => DIRECTION_CHINESE_LABELS[dirKey] || dirKey
      );

      // 表頭中繼資料 (Metadata Headers)
      const metaLines = [
        `# ── 眼動復能訓練系統 測驗成果報告 ──`,
        `# 受試者代號: ${subjectId || "-"}`,
        `# 測驗序號: ${sessionId}`,
        `# 測驗日期: ${isoDate}`,
        `# 測驗時間: ${isoTime}`,
        `# 訓練模組: ${moduleName} (${moduleCode})`,
        `# 測驗模式: ${settings.mode === EVALUATION ? "評估模式 (Evaluation)" : settings.mode === RANDOM ? "隨機模式 (Random)" : "可預測模式 (Predictable)"}`,
        `# 螢幕物理寬度: ${round(calibration.screenWidthCm, 2)} cm`,
        `# 螢幕物理高度: ${round(calibration.screenHeightCm, 2)} cm`,
        `# 螢幕像素解析度: ${screenPixels.width} x ${screenPixels.height} px`,
        `# 受試者觀看距離: ${round(calibration.viewingDistanceCm, 2)} cm`,
        `# 刺激物種類: ${(STIMULUS_TYPES[stimulusType] && STIMULUS_TYPES[stimulusType].name) || stimulusType}`,
        `# 刺激物大小: ${round(ballArcmin, 2)} 角分 (${(ballArcmin / 60).toFixed(2)}°)`,
        `# 移動速度: ${settings.speedArcminSec ? settings.speedArcminSec + " arcmin/s" : "N/A"}`,
        `# 命中距離閾值: ${thresholdDeg}° (${thresholdArcmin}' / 螢幕半徑約 ${thresholdPx} px)`,
        `# 測驗總時長: ${(actualDurationMs / 1000).toFixed(2)} 秒`,
        `# 有效注視時長 (分母): ${(totalValidMs / 1000).toFixed(2)} 秒`,
        `# 生理性眨眼時長 (剔除): ${(totalBlinkMs / 1000).toFixed(2)} 秒`,
        `# 低於閾值在標時長 (分子): ${(totalInThreshMs / 1000).toFixed(2)} 秒`,
        `# 眼動正確率: ${accuracyRate} %`,
        `# 啟用刺激方位: ${selectedDirectionLabelsChinese.join("、") || "全部"}`,
        `# 完成目標數: ${completedTargets}`,
        `# 測驗結束原因: ${reason}`,
        `# 硬體設備名稱: Tobii Eye Tracker 5`,
        `# 設備取樣頻率: 33 Hz (無損時序記錄)`,
        `# 總採樣筆數: ${records.length}`,
        `# ────────────────────────────────────────────────────────────`
      ];

      const tableHeaders = [
        "採樣序號",
        "自測驗開始毫秒 (ms)",
        "設備微秒時間戳記 (us)",
        "採樣間隔 (ms)",
        "瞬間頻率 (Hz)",
        "注視有效性 (1/0)",
        "注視點X (px)",
        "注視點Y (px)",
        "刺激物X (px)",
        "刺激物Y (px)",
        "瞬間距離誤差 (px)",
        "瞬間距離誤差 (deg)",
        "是否在閾值內 (1/0)",
        "測驗階段",
        "方位名稱"
      ];

      const rowLines = records.map(r => [
        r.sample_index,
        r.trial_time_ms,
        r.device_timestamp_us,
        r.delta_t_ms,
        r.instant_hz,
        r.gaze_valid,
        r.gaze_x_px,
        r.gaze_y_px,
        r.stimulus_x_px,
        r.stimulus_y_px,
        r.distance_error_px,
        r.distance_error_deg,
        r.is_within_threshold,
        csvEscape(r.phase),
        csvEscape(DIRECTION_CHINESE_LABELS[r.direction] || r.direction)
      ].join(","));

      const fullCsvContent = [
        ...metaLines,
        tableHeaders.join(","),
        ...rowLines
      ].join("\r\n");

      // 若在 .NET 宿主環境中，直接儲存至本機 Data/ 目錄
      if (window.chrome && window.chrome.webview && window.chrome.webview.hostObjects && window.chrome.webview.hostObjects.TobiiBridge) {
        try {
          window.chrome.webview.hostObjects.TobiiBridge.SaveCsv(csvFilename, fullCsvContent);
        } catch (e) {
          console.error("Native SaveCsv failed:", e);
        }
      }
      triggerFileDownload(csvFilename, fullCsvContent);
    }

    class EyeTrainingPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement, trial) {
        const moduleKey = trial.module;
        const settings = trial.settings;
        const calibration = trial.calibration;
        const eyeTracking = trial.eye_tracking || { source: EYE_SOURCE_OFF, enabled: false, calibrated: false, calibratedAt: null };
        const module = MODULES[moduleKey];
        const isTimed = moduleKey === "vor" || settings.mode !== EVALUATION;
        const plannedDurationMs = isTimed ? settings.totalSec * 1000 : null;
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const usesTobii = eyeTracking.source === EYE_SOURCE_TOBII;
        if (usesTobii) beginTobiiTrial(sessionId);
        const screenPixels = currentScreenPixels();
        const stimulusType = moduleKey === "vor" ? "numbers_dot" : (settings.stimulusType || "white_dot");
        const selectedDirs = (Array.isArray(settings.directions) && settings.directions.length > 0)
          ? settings.directions
          : [...ALL_DIRECTIONS];
        const ballArcsec = Number(settings.ballArcsec) || (settings.ballArcmin ? settings.ballArcmin * 60 : 3600);
        const ballArcmin = ballArcsec / 60;

        let ended = false;
        let finishSent = false;
        let sessionStart = null;
        let deadline = null;
        let rafId = null;
        let frameCount = 0;
        let lastFrameAt = null;
        let maxFrameGapMs = 0;
        let completedTargets = 0;
        let currentDirection = null;
        let phase = "idle";
        let viewportSettlesAt = null;
        let onTobiiDisconnect = null;
        const sampledFrameGaps = [];
        const events = [];
        const frameCoordinates = [];

        displayElement.innerHTML = `
          <section id="training-stage" class="training-stage" role="application" aria-label="${module.code} ${module.name} training in progress">
            <div id="training-stimulus" class="stimulus"><span id="stimulus-number" class="stimulus-number"></span></div>
            <span class="sr-only">Training has started. Press Escape to stop.</span>
          </section>`;

        const stage = displayElement.querySelector("#training-stage");
        const stimulus = displayElement.querySelector("#training-stimulus");
        const number = displayElement.querySelector("#stimulus-number");
        const readStageViewport = () => {
          const bounds = stage.getBoundingClientRect();
          return {
            width: bounds.width || window.innerWidth,
            height: bounds.height || window.innerHeight
          };
        };
        const initialViewport = readStageViewport();
        const targetSize = stimulusPixels(ballArcmin, calibration, screenPixels);
        const geometry = {
          viewportWidth: initialViewport.width,
          viewportHeight: initialViewport.height,
          targetWidth: targetSize.width,
          targetHeight: targetSize.height
        };
        const center = { x: geometry.viewportWidth / 2, y: geometry.viewportHeight / 2 };
        const currentCenter = { x: center.x, y: center.y };

        let saccadeOnsetMs = null;
        const thresholdArcmin = Number(settings.distanceThresholdArcmin) || 90;
        const thresholdDeg = thresholdArcmin / 60;
        const thresholdRadiusPx = (thresholdArcmin / ballArcmin) * (geometry.targetWidth / 2);
        const pxPerDeg = (geometry.targetWidth / ballArcmin) * 60;

        if (usesTobii && AppState.tobii.activeTrial) {
          AppState.tobii.activeTrial.onSample = (sample) => {
            if (ended || sessionStart === null) return;
            const nowPerf = performance.now();
            const active = AppState.tobii.activeTrial;
            if (!active) return;

            const currentTsUs = sample.device_timestamp_us || (Math.round(sample.browser_received_unix_ms * 1000));
            let deltaMs = 30.3;
            if (active.lastSampleTsUs !== null && currentTsUs > active.lastSampleTsUs) {
              deltaMs = (currentTsUs - active.lastSampleTsUs) / 1000;
            }
            active.lastSampleTsUs = currentTsUs;

            // 異常丟包保護 (超過 100ms 不連續加計)
            const effectiveDeltaMs = deltaMs > 100 ? 30.3 : deltaMs;

            // Saccade 200ms 生理潛伏期容許窗
            let isSaccadeLatency = false;
            if (moduleKey === "saccade" && phase === "dwell" && saccadeOnsetMs !== null) {
              if (nowPerf - saccadeOnsetMs < 200) {
                isSaccadeLatency = true;
              }
            }

            let isWithin = 0;
            let distPx = null;
            let distDeg = null;

            if (!sample.valid) {
              active.totalBlinkMs += effectiveDeltaMs;
            } else {
              distPx = Math.hypot(sample.x - currentCenter.x, sample.y - currentCenter.y);
              distDeg = pxPerDeg > 0 ? (distPx / pxPerDeg) : 0;

              if (!isSaccadeLatency) {
                active.totalValidMs += effectiveDeltaMs;
                if (distPx <= thresholdRadiusPx) {
                  isWithin = 1;
                  active.totalInThreshMs += effectiveDeltaMs;
                }
              }
            }

            active.synchronousRecords.push({
              sample_index: active.synchronousRecords.length + 1,
              trial_time_ms: round(nowPerf - sessionStart, 2),
              device_timestamp_us: currentTsUs,
              delta_t_ms: round(deltaMs, 2),
              instant_hz: deltaMs > 0 ? round(1000 / deltaMs, 1) : 33.0,
              gaze_valid: sample.valid ? 1 : 0,
              gaze_x_px: sample.valid ? round(sample.x, 2) : "",
              gaze_y_px: sample.valid ? round(sample.y, 2) : "",
              stimulus_x_px: round(currentCenter.x, 2),
              stimulus_y_px: round(currentCenter.y, 2),
              distance_error_px: distPx !== null ? round(distPx, 2) : "",
              distance_error_deg: distDeg !== null ? round(distDeg, 3) : "",
              is_within_threshold: isWithin,
              phase: isSaccadeLatency ? "saccade_latency" : phase,
              direction: currentDirection || currentGridKey || "center"
            });
          };
        }

        stimulus.style.width = `${geometry.targetWidth}px`;
        stimulus.style.height = `${geometry.targetHeight}px`;
        stimulus.style.setProperty("--cross-thickness", `${Math.max(1.5, Math.min(geometry.targetWidth, geometry.targetHeight) * 0.085)}px`);
        number.style.fontSize = `${Math.max(1, Math.min(geometry.targetWidth, geometry.targetHeight) * 0.55)}px`;

        const logEvent = (event, now, detail = {}) => {
          events.push({ event, actual_ms: sessionStart === null ? 0 : round(now - sessionStart, 3), ...detail });
        };

        const setPosition = (point) => {
          currentCenter.x = point.x;
          currentCenter.y = point.y;
          const x = point.x - geometry.targetWidth / 2;
          const y = point.y - geometry.targetHeight / 2;
          stimulus.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        };

        const refreshViewportGeometry = () => {
          const nextViewport = readStageViewport();
          geometry.viewportWidth = nextViewport.width;
          geometry.viewportHeight = nextViewport.height;
          center.x = nextViewport.width / 2;
          center.y = nextViewport.height / 2;
          if (phase === "idle" || phase === "cross" || moduleKey === "vor") {
            setPosition(center);
          }
        };

        const showCross = () => {
          stimulus.className = "stimulus is-cross";
          stimulus.style.removeProperty("--ball-color");
          number.textContent = "";
          setPosition(center);
        };

        const showWhiteDot = () => {
          stimulus.className = "stimulus is-ball";
          stimulus.style.setProperty("--ball-color", "#ffffff");
          number.textContent = "";
        };

        const showRedInWhite = () => {
          stimulus.className = "stimulus is-ball is-red-in-white";
          stimulus.style.setProperty("--ball-color", "#ffffff");
          number.textContent = "";
        };

        const showNumbersDot = (color, digit) => {
          stimulus.className = "stimulus is-ball";
          stimulus.style.setProperty("--ball-color", color);
          number.style.setProperty("--number-color", contrastingText(color));
          number.textContent = String(digit);
        };

        let currentDynamicColor = null;
        let currentDynamicDigit = null;
        let lastDynamicNumberTime = -1;
        const dynamicNumberInterval = settings.changeMs || 500;

        const updateDynamicNumber = (now, force = false) => {
          if (force || lastDynamicNumberTime < 0 || now - lastDynamicNumberTime >= dynamicNumberInterval) {
            let color;
            let digit;
            do color = VOR_COLORS[Math.floor(Math.random() * VOR_COLORS.length)]; while (color === currentDynamicColor);
            do digit = Math.floor(Math.random() * 10); while (digit === currentDynamicDigit);
            currentDynamicColor = color;
            currentDynamicDigit = digit;
            lastDynamicNumberTime = now;
            showNumbersDot(color, digit);
          }
        };

        const showActiveStimulus = (now, forceNewNumber = false) => {
          if (stimulusType === "red_in_white") {
            showRedInWhite();
          } else if (stimulusType === "numbers_dot") {
            updateDynamicNumber(now, forceNewNumber);
          } else {
            showWhiteDot();
          }
        };

        const geometryIsValid = () => {
          if (!Number.isFinite(geometry.targetWidth) || !Number.isFinite(geometry.targetHeight)) return false;
          if (geometry.targetWidth >= geometry.viewportWidth || geometry.targetHeight >= geometry.viewportHeight) return false;
          if (moduleKey === "saccade" && (geometry.targetWidth > geometry.viewportWidth / 3 || geometry.targetHeight > geometry.viewportHeight / 3)) return false;
          return true;
        };

        const onVisibilityChange = () => {
          if (document.visibilityState === "hidden") endTrial("visibility_hidden");
        };

        const onFullscreenChange = () => {
          if (trial.fullscreen_entered && !fullscreenElement() && !ended) endTrial("fullscreen_exit");
        };

        const onViewportChange = () => {
          const now = performance.now();
          if (sessionStart === null || (viewportSettlesAt !== null && now < viewportSettlesAt)) {
            refreshViewportGeometry();
            return;
          }
          const nextViewport = readStageViewport();
          const widthChanged = Math.abs(nextViewport.width - geometry.viewportWidth) > 1;
          const heightChanged = Math.abs(nextViewport.height - geometry.viewportHeight) > 1;
          if ((widthChanged || heightChanged) && !ended) endTrial("viewport_changed");
        };

        document.addEventListener("visibilitychange", onVisibilityChange);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);
        window.addEventListener("resize", onViewportChange);
        window.addEventListener("orientationchange", onViewportChange);
        if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportChange);

        const keyboardListener = this.jsPsych.pluginAPI.getKeyboardResponse({
          callback_function: () => endTrial("escape"),
          valid_responses: ["Escape"],
          rt_method: "performance",
          persist: false,
          allow_held_key: false
        });

        const median = (values) => {
          if (!values.length) return null;
          const sorted = [...values].sort((a, b) => a - b);
          const middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        };

        const finish = (data) => {
          if (finishSent) return;
          finishSent = true;
          this.jsPsych.finishTrial(data);
          void exitFullscreenSafely();
        };

        const endTrial = (reason) => {
          if (ended) return;
          ended = true;
          const endedAt = performance.now();
          if (rafId !== null) cancelAnimationFrame(rafId);
          this.jsPsych.pluginAPI.cancelKeyboardResponse(keyboardListener);
          this.jsPsych.pluginAPI.clearAllTimeouts();
          document.removeEventListener("visibilitychange", onVisibilityChange);
          document.removeEventListener("fullscreenchange", onFullscreenChange);
          document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
          window.removeEventListener("resize", onViewportChange);
          window.removeEventListener("orientationchange", onViewportChange);
          if (window.visualViewport) window.visualViewport.removeEventListener("resize", onViewportChange);
          if (onTobiiDisconnect) AppState.tobii.disconnectListeners.delete(onTobiiDisconnect);
          const tobiiCapture = usesTobii
            ? finishTobiiTrial(sessionId)
            : { samples: [], downsampled: 0, overflow: 0 };
          if (usesTobii && injectedBridgeClient && injectedBridgeClient.connectionState === "ready") {
            void injectedBridgeClient.stop().catch((error) => {
              AppState.tobii.lastError = error && error.message ? error.message : "Could not stop the Tobii Bridge provider after the trial.";
            });
          }
          const normalFrameMedian = median(sampledFrameGaps.filter((gap) => gap > 4 && gap < 100));

          // 自動匯出並下載單一無損 33Hz CSV 報告
          exportTrialCsvs({
            sessionId,
            subjectId,
            moduleKey,
            settings,
            calibration,
            screenPixels,
            geometry,
            ballArcmin,
            ballArcsec,
            targetSize,
            stimulusType,
            selectedDirs,
            isTimed,
            sessionStart,
            endedAt,
            reason,
            completedTargets,
            frameCoordinates,
            normalFrameMedian,
            eyeTrackingSource: eyeTracking.source,
            tobiiCapture
          });

          const data = {
            session_id: sessionId,
            module: moduleKey,
            mode: moduleKey === "vor" ? "continuous" : settings.mode,
            settings: { ...settings },
            calibration: { ...calibration },
            end_reason: reason,
            completed_targets: completedTargets,
            actual_duration_ms: round(sessionStart === null ? 0 : endedAt - sessionStart, 3),
            accuracy_rate: tobiiCapture.accuracyRate,
            in_threshold_sec: round((tobiiCapture.totalInThreshMs || 0) / 1000, 2),
            valid_sec: round((tobiiCapture.totalValidMs || 0) / 1000, 2),
            blink_sec: round((tobiiCapture.totalBlinkMs || 0) / 1000, 2),
            threshold_deg: thresholdDeg,
            threshold_arcmin: thresholdArcmin,
            planned_duration_ms: plannedDurationMs,
            fullscreen_entered: Boolean(trial.fullscreen_entered),
            eye_tracking: {
              source: eyeTracking.source || EYE_SOURCE_OFF,
              enabled: eyeTracking.source !== EYE_SOURCE_OFF,
              calibrated: Boolean(eyeTracking.calibrated),
              calibrated_at: eyeTracking.calibratedAt || null,
              library: eyeTracking.source === EYE_SOURCE_WEBGAZER
                ? "WebGazer via jsPsych extension-webgazer"
                : usesTobii ? "Local Tobii WebSocket Bridge" : null,
              provider: usesTobii ? AppState.tobii.provider : null,
              provider_mode: usesTobii ? AppState.tobii.providerMode : null,
              sampling_interval_ms: eyeTracking.source === EYE_SOURCE_WEBGAZER ? 34 : usesTobii ? TOBII_SAMPLE_INTERVAL_MS : null,
              hardware_calibration_confirmed: usesTobii ? AppState.tobii.hardwareCalibrationConfirmed : null
            },
            gaze_path: usesTobii ? JSON.stringify(tobiiCapture.samples) : null,
            gaze_sample_count: usesTobii ? tobiiCapture.samples.length : null,
            gaze_downsampled_count: usesTobii ? tobiiCapture.downsampled : null,
            gaze_overflow_count: usesTobii ? tobiiCapture.overflow : null,
            viewport: { width: geometry.viewportWidth, height: geometry.viewportHeight },
            stimulus: {
              arcsec: ballArcsec,
              arcmin: round(ballArcmin, 2),
              type: stimulusType,
              selected_directions: selectedDirs,
              width_px: round(geometry.targetWidth, 4),
              height_px: round(geometry.targetHeight, 4),
              diameter_cm: round(targetSize.diameterCm, 6)
            },
            timing: {
              clock: "performance.now",
              animation: "requestAnimationFrame",
              frame_count: frameCount,
              median_frame_gap_ms: normalFrameMedian === null ? null : round(normalFrameMedian, 3),
              max_frame_gap_ms: round(maxFrameGapMs, 3),
              estimated_refresh_hz: normalFrameMedian ? round(1000 / normalFrameMedian, 2) : null
            },
            predictable_start_index: picker && picker.predictableStart !== undefined ? picker.predictableStart : null,
            event_log: events,
            interaction_log: [...AppState.interactions],
            ended_at: new Date().toISOString()
          };
          finish(data);
        };

        if (usesTobii) {
          onTobiiDisconnect = (reason) => {
            if (!ended) {
              logEvent("eye_tracker_disconnected", performance.now(), { reason });
              endTrial("eye_tracker_disconnected");
            }
          };
          AppState.tobii.disconnectListeners.add(onTobiiDisconnect);
        }

        let picker = null;
        let phaseStart = 0;
        let phaseEnd = 0;
        let arrivalFrame = -1;
        let movementFrom = null;
        let movementTo = null;
        let movementDuration = 0;
        let vorIndex = -1;
        let lastVorColor = null;
        let lastVorDigit = null;
        let currentGridKey = "center";

        const updateVor = (index, now) => {
          let color;
          let digit;
          do color = VOR_COLORS[Math.floor(Math.random() * VOR_COLORS.length)]; while (color === lastVorColor);
          do digit = Math.floor(Math.random() * 10); while (digit === lastVorDigit);
          const skipped = vorIndex < 0 ? 0 : Math.max(0, index - vorIndex - 1);
          vorIndex = index;
          lastVorColor = color;
          lastVorDigit = digit;
          showNumbersDot(color, digit);
          setPosition(center);
          logEvent("vor_change", now, {
            index,
            planned_ms: round(index * settings.changeMs, 3),
            color,
            digit,
            skipped_intervals: skipped
          });
        };

        const beginExcursion = (now) => {
          currentDirection = picker.next(currentDirection, settings.mode === RANDOM);
          phase = "cross";
          phaseStart = now;
          phaseEnd = now + 1000;
          showCross();
          logEvent("cross_onset", now, {
            target_number: completedTargets + 1,
            direction: currentDirection,
            direction_label: DIRECTION_LABELS[currentDirection] || currentDirection
          });
        };

        const beginMovement = (now) => {
          phase = "movement";
          phaseStart = now;
          movementFrom = center;
          movementTo = edgePoint(currentDirection, geometry);
          movementDuration = movementDurationMs(movementFrom, movementTo, settings.speedArcminSec, calibration, screenPixels);
          phaseEnd = now + movementDuration;
          showActiveStimulus(now, true);
          setPosition(center);
          logEvent("movement_onset", now, {
            target_number: completedTargets + 1,
            direction: currentDirection,
            duration_ms: round(movementDuration, 3)
          });
        };

        const finishMovementAtEdge = (now) => {
          setPosition(movementTo);
          logEvent("edge_arrival", now, {
            target_number: completedTargets + 1,
            direction: currentDirection
          });
          if (moduleKey === "fixation") {
            phase = "hold";
            phaseStart = now;
            phaseEnd = now + settings.holdSec * 1000;
            showActiveStimulus(now);
            logEvent("fixation_onset", now, {
              target_number: completedTargets + 1,
              direction: currentDirection,
              planned_hold_ms: settings.holdSec * 1000
            });
          } else {
            completedTargets += 1;
            phase = "arrival_frame";
            arrivalFrame = frameCount;
          }
        };

        const showNextSaccadeTarget = (now) => {
          const nextKey = picker.next(currentGridKey, settings.mode === RANDOM);
          currentGridKey = nextKey;
          const point = gridPoint(nextKey, geometry);
          showActiveStimulus(now, true);
          setPosition(point);
          phase = "dwell";
          phaseStart = now;
          phaseEnd = now + settings.dwellMs;
          saccadeOnsetMs = now;
          logEvent("saccade_onset", now, {
            target_number: completedTargets + 1,
            direction: nextKey,
            direction_label: DIRECTION_LABELS[nextKey] || nextKey,
            planned_dwell_ms: settings.dwellMs
          });
        };

        const tickVor = (now) => {
          const dueIndex = Math.floor((now - sessionStart) / settings.changeMs);
          if (dueIndex > vorIndex) updateVor(dueIndex, now);
        };

        const tickExcursion = (now) => {
          if (phase === "cross" && now >= phaseEnd) {
            beginMovement(now);
            return;
          }
          if (phase === "movement") {
            const ratio = movementDuration <= 0 ? 1 : Math.min(1, Math.max(0, (now - phaseStart) / movementDuration));
            setPosition({
              x: movementFrom.x + (movementTo.x - movementFrom.x) * ratio,
              y: movementFrom.y + (movementTo.y - movementFrom.y) * ratio
            });
            if (stimulusType === "numbers_dot") {
              updateDynamicNumber(now);
            }
            if (ratio >= 1) finishMovementAtEdge(now);
            return;
          }
          if (phase === "arrival_frame" && frameCount > arrivalFrame) {
            if (settings.mode === EVALUATION && completedTargets >= picker.evaluationTotal) endTrial("evaluation_complete");
            else beginExcursion(now);
            return;
          }
          if (phase === "hold" && now >= phaseEnd) {
            completedTargets += 1;
            logEvent("fixation_complete", now, {
              target_number: completedTargets,
              direction: currentDirection,
              actual_hold_ms: round(now - phaseStart, 3)
            });
            if (settings.mode === EVALUATION && completedTargets >= picker.evaluationTotal) endTrial("evaluation_complete");
            else beginExcursion(now);
          } else if (phase === "hold" && stimulusType === "numbers_dot") {
            updateDynamicNumber(now);
          }
        };

        const tickSaccade = (now) => {
          if (phase === "cross" && now >= phaseEnd) {
            showNextSaccadeTarget(now);
            return;
          }
          if (phase === "dwell" && now >= phaseEnd) {
            completedTargets += 1;
            logEvent("saccade_dwell_complete", now, {
              target_number: completedTargets,
              direction: currentGridKey,
              actual_dwell_ms: round(now - phaseStart, 3)
            });
            if (settings.mode === EVALUATION && completedTargets >= picker.evaluationTotal) endTrial("evaluation_complete");
            else showNextSaccadeTarget(now);
          } else if (phase === "dwell" && stimulusType === "numbers_dot") {
            updateDynamicNumber(now);
          }
        };

        const tick = (now) => {
          if (ended) return;
          frameCount += 1;
          if (lastFrameAt !== null) {
            const gap = now - lastFrameAt;
            maxFrameGapMs = Math.max(maxFrameGapMs, gap);
            if (sampledFrameGaps.length < 600) sampledFrameGaps.push(gap);
          }
          lastFrameAt = now;
          if (isTimed && deadline !== null && now >= deadline) {
            endTrial("duration_complete");
            return;
          }
          if (moduleKey === "vor") tickVor(now);
          else if (moduleKey === "saccade") tickSaccade(now);
          else tickExcursion(now);

          if (sessionStart !== null && !ended) {
            frameCoordinates.push({
              frame_index: frameCount,
              timestamp_ms: round(now - sessionStart, 3),
              time_sec: round((now - sessionStart) / 1000, 4),
              phase,
              target_number: completedTargets + 1,
              direction: currentDirection || currentGridKey || "center",
              direction_label: DIRECTION_CHINESE_LABELS[currentDirection || currentGridKey] || currentDirection || currentGridKey || "中央",
              stimulus_center_x: round(currentCenter.x, 3),
              stimulus_center_y: round(currentCenter.y, 3),
              stimulus_center_norm_x: geometry.viewportWidth > 0 ? round(currentCenter.x / geometry.viewportWidth, 5) : 0,
              stimulus_center_norm_y: geometry.viewportHeight > 0 ? round(currentCenter.y / geometry.viewportHeight, 5) : 0,
              stimulus_type: (STIMULUS_TYPES[stimulusType] && STIMULUS_TYPES[stimulusType].name) || stimulusType,
              stimulus_color: currentDynamicColor || "#ffffff",
              stimulus_digit: currentDynamicDigit !== null && currentDynamicDigit !== undefined ? String(currentDynamicDigit) : ""
            });
          }

          if (!ended) rafId = requestAnimationFrame(tick);
        };

        const startSession = (now) => {
          if (ended) return;
          refreshViewportGeometry();
          sessionStart = now;
          // Fullscreen and dynamic viewport units can emit resize events after
          // the stage is mounted. They are layout settling, not user aborts.
          viewportSettlesAt = now + 1000;
          deadline = isTimed ? now + plannedDurationMs : null;
          if (!geometryIsValid()) {
            endTrial("invalid_geometry");
            return;
          }
          if (isTimed) {
            this.jsPsych.pluginAPI.setTimeout(() => endTrial("duration_complete"), plannedDurationMs);
          }
          if (moduleKey === "vor") {
            showActiveStimulus(now, true);
            updateVor(0, now);
          } else if (moduleKey === "saccade") {
            const saccadeSequence = buildSaccadeSequence(selectedDirs, settings.mode);
            picker = makePicker(settings.mode, saccadeSequence, 1, selectedDirs);
            phase = "cross";
            phaseStart = now;
            phaseEnd = now + 1000;
            showCross();
            logEvent("cross_onset", now, { target_number: 1, direction: "center", direction_label: "Center" });
          } else {
            const activeSequence = EDGE_SEQUENCE.filter(d => selectedDirs.includes(d));
            const excursionPool = activeSequence.length > 0 ? activeSequence : selectedDirs;
            picker = makePicker(settings.mode, excursionPool, 2, excursionPool);
            beginExcursion(now);
          }
          tick(now);
        };

        if (moduleKey === "vor") showActiveStimulus(performance.now(), true);
        else showCross();
        setPosition(center);
        rafId = requestAnimationFrame(startSession);
      }
    }

    EyeTrainingPlugin.info = {
      name: "eye-movement-training",
      version: "1.0.0",
      parameters: {
        module: { type: ParameterType.STRING },
        settings: { type: ParameterType.OBJECT },
        calibration: { type: ParameterType.OBJECT },
        eye_tracking: { type: ParameterType.OBJECT },
        fullscreen_entered: { type: ParameterType.BOOL, default: false }
      },
      data: {
        session_id: { type: ParameterType.STRING },
        module: { type: ParameterType.STRING },
        mode: { type: ParameterType.STRING },
        end_reason: { type: ParameterType.STRING },
        actual_duration_ms: { type: ParameterType.FLOAT },
        completed_targets: { type: ParameterType.INT },
        gaze_path: { type: ParameterType.STRING },
        gaze_sample_count: { type: ParameterType.INT },
        gaze_downsampled_count: { type: ParameterType.INT },
        gaze_overflow_count: { type: ParameterType.INT }
      }
    };

    const PIPE_EXPERIMENT_ID = "SkINkJZOF9mT";
    const PIPE_QUEUE_KEY = "oculomotor-training-pipe-queue-v1";
    const PIPE_DB_NAME = "oculomotor-training-local-json";
    const PIPE_DB_STORE = "pending_uploads";
    let subjectId = null;
    let isFlushingUploadQueue = false;
    let uploadDatabasePromise = null;
    let uploadRetryTimer = null;

    function readLegacyUploadQueue() {
      try {
        const saved = window.localStorage.getItem(PIPE_QUEUE_KEY);
        const parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }

    function writeLegacyUploadQueue(queue) {
      try {
        window.localStorage.setItem(PIPE_QUEUE_KEY, JSON.stringify(queue));
        return true;
      } catch (error) {
        return false;
      }
    }

    function openUploadDatabase() {
      if (!("indexedDB" in window)) return Promise.resolve(null);
      if (uploadDatabasePromise) return uploadDatabasePromise;
      uploadDatabasePromise = new Promise((resolve) => {
        let request;
        try {
          request = window.indexedDB.open(PIPE_DB_NAME, 1);
        } catch (error) {
          resolve(null);
          return;
        }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(PIPE_DB_STORE)) {
            request.result.createObjectStore(PIPE_DB_STORE, { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
      return uploadDatabasePromise;
    }

    function runUploadStore(db, mode, operation) {
      return new Promise((resolve, reject) => {
        let request;
        try {
          const transaction = db.transaction(PIPE_DB_STORE, mode);
          request = operation(transaction.objectStore(PIPE_DB_STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
          transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
        } catch (error) {
          reject(error);
        }
      });
    }

    async function readPendingUploads() {
      const db = await openUploadDatabase();
      if (!db) return readLegacyUploadQueue();
      try {
        return await runUploadStore(db, "readonly", (store) => store.getAll());
      } catch (error) {
        return readLegacyUploadQueue();
      }
    }

    async function putPendingUpload(record) {
      const db = await openUploadDatabase();
      if (db) {
        try {
          await runUploadStore(db, "readwrite", (store) => store.put(record));
          return true;
        } catch (error) { /* Fall back to localStorage below. */ }
      }
      const queue = readLegacyUploadQueue();
      const index = queue.findIndex((item) => item.id === record.id);
      if (index >= 0) queue[index] = record;
      else queue.push(record);
      return writeLegacyUploadQueue(queue);
    }

    async function deletePendingUpload(id) {
      const db = await openUploadDatabase();
      if (db) {
        try {
          await runUploadStore(db, "readwrite", (store) => store.delete(id));
        } catch (error) { /* Also clean up any legacy copy below. */ }
      }
      const legacy = readLegacyUploadQueue();
      if (legacy.some((record) => record.id === id)) {
        writeLegacyUploadQueue(legacy.filter((record) => record.id !== id));
      }
    }

    async function migrateLegacyUploadQueue() {
      const legacy = readLegacyUploadQueue();
      if (!legacy.length) return;
      const db = await openUploadDatabase();
      if (!db) return;
      for (const record of legacy) {
        await runUploadStore(db, "readwrite", (store) => store.put(record));
      }
      try { window.localStorage.removeItem(PIPE_QUEUE_KEY); } catch (error) { /* Migration still succeeded. */ }
    }

    async function updatePendingUploadCount() {
      const records = await readPendingUploads();
      AppState.upload.pendingCount = records.length;
      refreshUploadStatus();
      return records;
    }

    async function uploadToPipe(record) {
      if (!navigator.onLine) return { success: false, error: "offline" };
      try {
        const requestJson = JSON.stringify({
          experimentID: record.experimentId || PIPE_EXPERIMENT_ID,
          filename: record.filename,
          data: record.dataString
        });
        const headers = { "Content-Type": "application/json" };
        let body = requestJson;
        if (requestJson.length > 512000 && typeof window.CompressionStream === "function") {
          const compressedStream = new Blob([requestJson]).stream().pipeThrough(new CompressionStream("gzip"));
          body = await new Response(compressedStream).arrayBuffer();
          headers["Content-Encoding"] = "gzip";
        }
        const response = await fetch("https://pipe.jspsych.org/api/data/", {
          method: "POST",
          headers,
          body
        });
        const result = await response.json().catch(() => ({}));
        const success = (response.ok && result.message === "Success") || result.error === "OSF_FILE_EXISTS";
        return {
          success,
          error: success ? null : (result.error || `HTTP_${response.status}`),
          message: result.message || response.statusText || null
        };
      } catch (error) {
        return { success: false, error: error && error.message ? error.message : "network_error" };
      }
    }

    async function flushPendingUploads() {
      if (isFlushingUploadQueue) return;
      if (!navigator.onLine) {
        AppState.upload.status = "queued";
        AppState.upload.lastError = "offline";
        await updatePendingUploadCount();
        return;
      }
      isFlushingUploadQueue = true;
      AppState.upload.status = "uploading";
      AppState.upload.lastError = null;
      refreshUploadStatus();
      try {
        const snapshot = await readPendingUploads();
        for (const record of snapshot) {
          const result = await uploadToPipe(record);
          if (result.success) {
            await deletePendingUpload(record.id);
            AppState.upload.lastFilename = record.filename;
          } else {
            AppState.upload.lastError = [result.error, result.message].filter(Boolean).join(": ");
            await putPendingUpload({
              ...record,
              attempts: (record.attempts || 0) + 1,
              lastAttemptAt: new Date().toISOString(),
              lastError: AppState.upload.lastError
            });
          }
        }
        const pending = await updatePendingUploadCount();
        AppState.upload.status = pending.length ? "queued" : "uploaded";
        refreshUploadStatus();
        if (pending.length && navigator.onLine && uploadRetryTimer === null) {
          const highestAttempts = Math.max(...pending.map((record) => Number(record.attempts) || 0), 1);
          const retryDelay = Math.min(3600000, 60000 * (2 ** Math.min(highestAttempts - 1, 5)));
          uploadRetryTimer = window.setTimeout(() => {
            uploadRetryTimer = null;
            void flushPendingUploads();
          }, retryDelay);
        }
      } finally {
        isFlushingUploadQueue = false;
      }
    }

    async function queueTrainingUpload(data, jsPsychInstance) {
      const sessionId = data.session_id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const record = {
        id: sessionId,
        experimentId: PIPE_EXPERIMENT_ID,
        subjectId,
        filename: `${subjectId}_${sessionId}.csv`,
        dataString: jsPsychInstance.data.get().filter({ session_id: sessionId }).csv(),
        queuedAt: new Date().toISOString(),
        attempts: 0
      };
      const stored = await putPendingUpload(record);
      AppState.upload.status = "queued";
      AppState.upload.lastError = stored ? null : "Local JSON storage quota was exceeded.";
      await updatePendingUploadCount();
      await flushPendingUploads();
    }

    const jsPsychOptions = {
      display_element: "experiment-root",
      use_webaudio: false,
      override_safe_mode: true,
      show_progress_bar: false,
      default_iti: 0,
      on_data_update(data) {
        if (data.trial_type === "eye-movement-training") queueTrainingUpload(data, jsPsych);
      },
      on_interaction_data_update(data) {
        AppState.interactions.push({ ...data });
      }
    };

    if (WEBGAZER_COMPONENTS_AVAILABLE) {
      jsPsychOptions.extensions = [{
        type: window.jsPsychExtensionWebgazer,
        params: {
          auto_initialize: false,
          round_predictions: true,
          sampling_interval: 34
        }
      }];
    }

    const jsPsych = initJsPsych(jsPsychOptions);
    window.jsPsychInstance = jsPsych;

    subjectId = getInitialSubjectId();
    jsPsych.data.addProperties({ subject_id: subjectId });
    window.addEventListener("online", () => { void flushPendingUploads(); });
    window.addEventListener("focus", () => { void flushPendingUploads(); });
    void migrateLegacyUploadQueue().then(() => flushPendingUploads());

    const makeTrainingTrial = (source) => {
      const withWebGazer = source === EYE_SOURCE_WEBGAZER;
      const trial = {
        type: EyeTrainingPlugin,
        module: () => AppState.pending.module,
        settings: () => AppState.pending.settings,
        calibration: () => AppState.pending.calibration,
        eye_tracking: () => ({
          source,
          enabled: source !== EYE_SOURCE_OFF,
          calibrated: withWebGazer
            ? AppState.eyeTracking.calibrated
            : source === EYE_SOURCE_TOBII ? AppState.tobii.hardwareCalibrationConfirmed : false,
          calibratedAt: withWebGazer ? AppState.eyeTracking.calibratedAt : null
        }),
        fullscreen_entered: () => AppState.pending.fullscreenEntered,
        on_finish(data) {
          AppState.lastSession = { ...data };
          AppState.pending = null;
          sendDiscordNotification(data.module);
        }
      };
      if (withWebGazer) {
        trial.extensions = [{
          type: window.jsPsychExtensionWebgazer,
          params: { targets: ["#training-stimulus"] }
        }];
      }
      return trial;
    };

    const untrackedTrainingTrial = makeTrainingTrial(EYE_SOURCE_OFF);
    const webgazerTrainingTrial = WEBGAZER_COMPONENTS_AVAILABLE ? makeTrainingTrial(EYE_SOURCE_WEBGAZER) : null;
    const tobiiTrainingTrial = makeTrainingTrial(EYE_SOURCE_TOBII);

    function fallBackToUntrackedSession(reason) {
      if (AppState.pending) {
        AppState.pending.eyeTrackingEnabled = false;
        AppState.pending.eyeTrackingSource = EYE_SOURCE_OFF;
        AppState.pending.fullscreenEntered = Boolean(fullscreenElement());
      }
      AppState.eyeTracking.lastError = reason;
      void stopEyeTrackingRuntime();
    }

    function pendingSessionGeometryIsValid(reference = AppState.pending && AppState.pending.setupViewport) {
      if (!AppState.pending || !reference) return false;
      const current = currentViewportSignature();
      if (AppState.pending.fullscreenEntered && !current.fullscreen) return false;
      return viewportSignaturesMatch(reference, current);
    }

    let calibrationStartViewport = null;

    const webgazerSetupNode = WEBGAZER_COMPONENTS_AVAILABLE ? {
      timeline: [
        {
          timeline: [{
            type: OptionalWebGazerCameraPlugin,
            data: { action: "webgazer_camera_initialized" },
            on_finish(data) {
              if (data.ready && pendingSessionGeometryIsValid()) {
                AppState.eyeTracking.initialized = true;
                AppState.eyeTracking.lastError = null;
              } else {
                fallBackToUntrackedSession(data.error || "Fullscreen or viewport changed during camera setup.");
              }
            }
          }],
          conditional_function: () => !AppState.eyeTracking.initialized
        },
        {
          timeline: [{
            type: window.jsPsychWebgazerCalibrate,
            calibration_points: [
              [10, 10], [50, 10], [90, 10],
              [10, 50], [50, 50], [90, 50],
              [10, 90], [50, 90], [90, 90]
            ],
            calibration_mode: "click",
            repetitions_per_point: 2,
            point_size: 24,
            randomize_calibration_order: true,
            data: { action: "webgazer_calibrated" },
            on_start() {
              calibrationStartViewport = currentViewportSignature();
              try { jsPsych.extensions.webgazer.resetCalibration(); } catch (error) { /* First calibration has no prior model. */ }
            },
            on_finish(data) {
              const finishedViewport = currentViewportSignature();
              const geometryStayedValid = viewportSignaturesMatch(calibrationStartViewport, finishedViewport) &&
                pendingSessionGeometryIsValid(calibrationStartViewport);
              if (!geometryStayedValid) {
                data.webgazer_calibration_error = "Fullscreen or viewport changed during calibration.";
                fallBackToUntrackedSession(data.webgazer_calibration_error);
                return;
              }
              AppState.eyeTracking.calibrated = true;
              AppState.eyeTracking.calibrationRequested = false;
              AppState.eyeTracking.calibratedAt = new Date().toISOString();
              AppState.eyeTracking.calibrationViewport = finishedViewport;
              AppState.eyeTracking.lastError = null;
              data.webgazer_calibrated_at = AppState.eyeTracking.calibratedAt;
              data.webgazer_calibration_viewport = finishedViewport;
            }
          }],
          conditional_function: () => Boolean(
            AppState.pending &&
            AppState.pending.eyeTrackingEnabled &&
            AppState.eyeTracking.initialized &&
            AppState.eyeTracking.calibrationRequested
          )
        }
      ],
      conditional_function: () => Boolean(
        AppState.pending &&
        AppState.pending.eyeTrackingEnabled &&
        AppState.eyeTracking.calibrationRequested
      )
    } : { timeline: [], conditional_function: () => false };

    function webgazerSessionIsReady() {
      if (!webgazerTrainingTrial || !AppState.pending || AppState.pending.eyeTrackingSource !== EYE_SOURCE_WEBGAZER || !AppState.eyeTracking.calibrated) {
        return false;
      }
      if (!viewportSignaturesMatch(AppState.eyeTracking.calibrationViewport, currentViewportSignature())) {
        fallBackToUntrackedSession("Fullscreen or viewport changed after eye-tracker calibration.");
        return false;
      }
      return true;
    }

    function tobiiSessionIsReady() {
      if (!AppState.pending || AppState.pending.eyeTrackingSource !== EYE_SOURCE_TOBII) return false;
      if (!AppState.pending.fullscreenEntered || !fullscreenElement()) {
        AppState.lastSession = {
          module: AppState.pending.module,
          end_reason: "fullscreen_required",
          actual_duration_ms: 0
        };
        AppState.pending = null;
        return false;
      }
      if (!AppState.tobii.connected || !AppState.tobii.hardwareCalibrationConfirmed) {
        AppState.lastSession = {
          module: AppState.pending.module,
          end_reason: "eye_tracker_unavailable",
          actual_duration_ms: 0
        };
        AppState.pending = null;
        return false;
      }
      return true;
    }

    const applicationLoop = {
      timeline: [
        { type: MenuPlugin },
        webgazerSetupNode,
        {
          timeline: webgazerTrainingTrial ? [webgazerTrainingTrial] : [],
          conditional_function: webgazerSessionIsReady
        },
        {
          timeline: [tobiiTrainingTrial],
          conditional_function: tobiiSessionIsReady
        },
        {
          timeline: [untrackedTrainingTrial],
          conditional_function: () => Boolean(
            AppState.pending && AppState.pending.eyeTrackingSource === EYE_SOURCE_OFF
          )
        }
      ],
      loop_function: () => true
    };

    jsPsych.run([
      { type: CalibrationPlugin },
      applicationLoop
    ]);
  })();
  