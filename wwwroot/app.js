
    // ════════════════════════════════════════════════════
    // Tobii native SDK events preserve the original stream timestamps.
    // ════════════════════════════════════════════════════


  "use strict";

  (() => {
    // ════════════════════════════════════════════════════
    // Patient Name and Webhook Configuration
    // ════════════════════════════════════════════════════
    const PATIENT_NAME = "Participant";
    const DISCORD_WEBHOOK_URL = "nothing";

    const SUBTEST_NAMES = {
      vor: "VOR",
      pursuit: "Pursuit",
      saccade: "Saccade",
      fixation: "Fixation"
    };

    async function sendDiscordNotification(moduleKey) {
      const moduleName = SUBTEST_NAMES[moduleKey] || (MODULES[moduleKey] && MODULES[moduleKey].code) || moduleKey;
      const message = `${PATIENT_NAME} completed ${moduleName} training!`;
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
    // Trial Lockout: 30 days expiry protection
    // ════════════════════════════════════════════════════
    const EXPIRY_LS_KEY      = "ocm-first-launch-ts";
    const LAST_SEEN_LS_KEY   = "ocm-last-seen-ts";
    const ONE_MONTH_MS       = 30 * 24 * 60 * 60 * 1000;
    const ROLLBACK_GRACE_MS  = 5 * 60 * 1000;

    /**
     * Attempts to fetch trusted network time.
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
            return Math.max(t, localNow);
          }
        } catch (_) { /* Continue to next source */ }
      }
      return localNow;
    }

    /**
     * Displays lockout screen.
     */
    function showLockscreen(reason = "expired") {
      const messages = {
        expired:  "Access Period Expired",
        rollback: "System Clock Alteration Detected",
      };
      const details = {
        expired:  "The authorization period for this training program has ended.<br>To continue usage, please contact your vision specialist.",
        rollback: "System time mismatch detected.<br>Program access has been locked to protect protocol integrity.",
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

      // Block all user interactions
      ["keydown","keyup","keypress","click","mousedown","mouseup","contextmenu","touchstart"]
        .forEach(evt => document.addEventListener(evt, e => e.preventDefault(), true));
    }

    /** Expiry and clock rollback check */
    async function checkExpiry() {
      const nowMs = await fetchNetworkTime();

      // ── 1. First launch timestamp ─────────────────────────
      let firstLaunchMs = Number(localStorage.getItem(EXPIRY_LS_KEY));
      if (!firstLaunchMs || isNaN(firstLaunchMs)) {
        firstLaunchMs = nowMs;
        localStorage.setItem(EXPIRY_LS_KEY, String(firstLaunchMs));
      }

      // ── 2. Clock rollback detection ───────────────────────
      const lastSeenMs = Number(localStorage.getItem(LAST_SEEN_LS_KEY));
      if (lastSeenMs && !isNaN(lastSeenMs)) {
        if (nowMs < lastSeenMs - ROLLBACK_GRACE_MS) {
          showLockscreen("rollback");
          return;
        }
      }

      // ── 3. Expiration verification ────────────────────────
      const expiryMs = firstLaunchMs + ONE_MONTH_MS;
      if (nowMs >= expiryMs) {
        showLockscreen("expired");
        return;
      }

      // ── 4. Update last seen timestamp ─────────────────────
      const newLastSeen = Math.max(nowMs, lastSeenMs || 0);
      localStorage.setItem(LAST_SEEN_LS_KEY, String(newLastSeen));
    }

    // Execute expiry verification immediately
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
    const MAX_GAZE_SAMPLES_PER_TRIAL = 36000;
    const TOBII_ERROR_ALLOWANCE_DEG = 1;
    const WEBGAZER_ERROR_ALLOWANCE_DEG = 2;
    const FIXATION_VELOCITY_DEG_SEC = 30;
    const FIXATION_MIN_DURATION_MS = 100;
    const FIXATION_MAX_GAP_MS = 100;
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
    const nativeBridge = window.OcuTrainDesktop;

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
        description: "Follow the target from the center to the screen edge and back. Accuracy includes both movements and excludes the central cross."
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
        description: "Follow the target to the screen edge and keep your gaze fixed while it remains there. Accuracy includes only the edge hold."
      }
    };

    const ALL_DIRECTIONS = [
      "leftUp", "middleUp", "rightUp",
      "leftMiddle", "rightMiddle",
      "leftDown", "middleDown", "rightDown"
    ];

    const NINE_GRID_SLOTS = [
      { type: "dir", key: "leftUp",      label: "Top-Left",     arrow: "↖" },
      { type: "dir", key: "middleUp",    label: "Up",           arrow: "↑" },
      { type: "dir", key: "rightUp",     label: "Top-Right",    arrow: "↗" },
      { type: "dir", key: "leftMiddle",  label: "Left",         arrow: "←" },
      { type: "center", key: "all",      label: "Select All",   arrow: "ALL" },
      { type: "dir", key: "rightMiddle", label: "Right",        arrow: "→" },
      { type: "dir", key: "leftDown",    label: "Bottom-Left",  arrow: "↙" },
      { type: "dir", key: "middleDown",  label: "Down",         arrow: "↓" },
      { type: "dir", key: "rightDown",   label: "Bottom-Right", arrow: "↘" }
    ];

    const STIMULUS_TYPES = {
      white_dot: { id: "white_dot", name: "White dot", meta: "Standard solid white dot" },
      red_in_white: { id: "red_in_white", name: "Red in White", meta: "White circle with red center" },
      numbers_dot: { id: "numbers_dot", name: "Numbers dot", meta: "Dynamic color & number target" }
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
      rightUp: "Upper Right",
      leftUp: "Upper Left",
      rightDown: "Lower Right",
      leftDown: "Lower Left",
      rightMiddle: "Right",
      leftMiddle: "Left",
      middleUp: "Up",
      middleDown: "Down",
      center: "Center"
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
        source: EYE_SOURCE_OFF,
        available: WEBGAZER_COMPONENTS_AVAILABLE,
        enabled: false,
        initialized: false,
        calibrated: false,
        calibrationRequested: false,
        needsRecalibration: false,
        calibratedAt: null,
        calibrationViewport: null,
        lastValidation: null,
        lastError: null
      },
      tobii: {
        configured: Boolean(nativeBridge || injectedBridgeClient || configuredBridgeUrl),
        endpoint: configuredBridgeUrl,
        status: "disconnected",
        connected: false,
        provider: null,
        providerMode: null,
        coordinateSpace: nativeBridge ? "screen_normalized" : null,
        clockOffsetMs: null,
        clockUncertaintyMs: null,
        hardwareCalibrationConfirmed: false,
        validated: false,
        needsRevalidation: false,
        lastError: null,
        lastMessageAt: null,
        receivedSamples: 0,
        validSamples: 0,
        lastGazeAt: null,
        lastValidGazeAt: null,
        socket: null,
        connectPromise: null,
        injectedClientBound: false,
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

    function gazeErrorDegrees(dxPx, dyPx, calibration, screenPixels) {
      const dxCm = dxPx * calibration.screenWidthCm / screenPixels.width;
      const dyCm = dyPx * calibration.screenHeightCm / screenPixels.height;
      return visualAngleArcmin(Math.hypot(dxCm, dyCm), calibration.viewingDistanceCm) / 60;
    }

    function gazeThresholds(source, settings, validation = AppState.eyeTracking.lastValidation) {
      const baseDeg = (Number(settings.distanceThresholdArcmin) || 90) / 60;
      const allowanceDeg = source === EYE_SOURCE_TOBII ? TOBII_ERROR_ALLOWANCE_DEG
        : source === EYE_SOURCE_WEBGAZER ? WEBGAZER_ERROR_ALLOWANCE_DEG : 0;
      const validationDeg = validation?.source === source && Number.isFinite(validation.dynamicThresholdDeg) && validation.dynamicThresholdDeg > 0
        ? validation.dynamicThresholdDeg : null;
      // Validation already includes tracker error; use the larger threshold to avoid adding it twice.
      const effectiveDeg = Math.max(baseDeg + allowanceDeg, validationDeg || 0);
      return { baseDeg: round(baseDeg, 2), allowanceDeg, validationDeg, effectiveDeg: round(effectiveDeg, 2) };
    }

    function accuracyPhaseStart(moduleKey, frame) {
      if (moduleKey === "pursuit" && !["movement", "return"].includes(frame.phase)) return null;
      if (moduleKey === "fixation" && frame.phase !== "hold") return null;
      return frame.phase_started_ms + (moduleKey === "saccade" && frame.phase === "dwell" ? 200 : 0);
    }

    function accuracyDurationMs(moduleKey, frames, frameIndex, sampleTime, durationMs) {
      const current = frames[frameIndex];
      const intervalStart = Math.max(0, sampleTime - durationMs,
        moduleKey === "saccade" ? current.phase_started_ms : 0);
      let right = sampleTime;
      let scoredMs = 0;
      for (let index = frameIndex; index >= 0 && right > intervalStart; index--) {
        const frame = frames[index];
        const left = Math.max(intervalStart, frame.timestamp_ms);
        const eligibleStart = accuracyPhaseStart(moduleKey, frame);
        if (eligibleStart !== null) scoredMs += Math.max(0, right - Math.max(left, eligibleStart));
        right = left;
      }
      return scoredMs;
    }

    function saccadeFixationSummary(records, events, calibration, screenPixels) {
      const targets = events.filter(event => event.event === "saccade_onset").map(event => ({
        target_number: event.target_number,
        direction: event.direction,
        target_onset_ms: event.actual_ms,
        fixation_onset_ms: null,
        fixation_confirmed_ms: null,
        tff_ms: null,
        status: "no_valid_samples"
      }));
      const byNumber = new Map(targets.map(target => [target.target_number, target]));
      let target = null;
      let previous = null;
      let movementDetected = false;
      let run = [];
      let confirmed = false;

      // I-VT-style classification: source-time velocity, not distance from the target.
      for (const record of records) {
        record.gaze_velocity_deg_s = "";
        record.is_fixation = 0;
        if (!["dwell", "saccade_latency"].includes(record.phase)) {
          previous = record.gaze_valid ? record : null;
          continue;
        }
        const nextTarget = byNumber.get(record.target_number);
        if (!nextTarget) continue;
        if (nextTarget !== target) {
          target = nextTarget;
          movementDetected = false;
          run = [];
          confirmed = false;
        }
        if (!record.gaze_valid) {
          previous = null;
          run = [];
          confirmed = false;
          continue;
        }
        if (target.status === "no_valid_samples") target.status = "no_movement_detected";
        const deltaMs = previous ? (record.device_timestamp_us - previous.device_timestamp_us) / 1000 : null;
        if (deltaMs === null || deltaMs <= 0 || deltaMs > FIXATION_MAX_GAP_MS) {
          run = [record];
          confirmed = false;
        } else {
          const velocity = gazeErrorDegrees(record.gaze_x_px - previous.gaze_x_px,
            record.gaze_y_px - previous.gaze_y_px, calibration, screenPixels) * 1000 / deltaMs;
          record.gaze_velocity_deg_s = round(velocity, 3);
          if (velocity > FIXATION_VELOCITY_DEG_SEC) {
            movementDetected = true;
            if (target.tff_ms === null) target.status = "no_confirmed_fixation";
            run = [record];
            confirmed = false;
          } else {
            run.push(record);
            if (run.length >= 3 && record.trial_time_ms - run[0].trial_time_ms >= FIXATION_MIN_DURATION_MS) {
              if (!confirmed) {
                run.forEach(sample => { sample.is_fixation = 1; });
                confirmed = true;
              }
              record.is_fixation = 1;
              if (movementDetected && target.tff_ms === null) {
                target.fixation_onset_ms = run[0].trial_time_ms;
                target.fixation_confirmed_ms = record.trial_time_ms;
                target.tff_ms = round(target.fixation_onset_ms - target.target_onset_ms, 2);
                target.status = "detected";
              }
            }
          }
        }
        previous = record;
      }
      for (const record of records) {
        record.tff_ms = ["dwell", "saccade_latency"].includes(record.phase)
          ? byNumber.get(record.target_number)?.tff_ms ?? "" : "";
      }
      const detected = targets.filter(target => target.tff_ms !== null);
      return {
        mean_ms: detected.length ? round(detected.reduce((sum, target) => sum + target.tff_ms, 0) / detected.length, 2) : null,
        detected_targets: detected.length,
        total_targets: targets.length,
        velocity_threshold_deg_s: FIXATION_VELOCITY_DEG_SEC,
        minimum_duration_ms: FIXATION_MIN_DURATION_MS,
        maximum_gap_ms: FIXATION_MAX_GAP_MS,
        requires_movement: true,
        requires_target_hit: false,
        targets
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
        if (AppState.tobii.connected) {
          if (AppState.tobii.providerMode === "simulator") return "Eye tracking: Tobii Simulator";
          const tracking = AppState.tobii.lastValidGazeAt !== null && performance.now() - AppState.tobii.lastValidGazeAt < 1500;
          return tracking ? "Eye tracking: Tobii tracking" : "Eye tracking: Tobii — no valid gaze";
        }
        return "Eye tracking: Tobii disconnected";
      }
      if (AppState.eyeTracking.source === EYE_SOURCE_WEBGAZER) {
        if (!AppState.eyeTracking.available) return "Eye tracking unavailable";
        if (AppState.eyeTracking.calibrated) {
          const val = AppState.eyeTracking.lastValidation;
          return val && val.meanErrorDeg != null
            ? `Eye tracking: WebGazer ready (${val.meanErrorDeg}°)`
            : "Eye tracking: WebGazer ready";
        }
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
        return `Connected to ${provider}${simulator}. Received: ${AppState.tobii.receivedSamples} samples; valid: ${AppState.tobii.validSamples}.`;
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
      if (left.fullscreen && right.fullscreen &&
          left.screenWidth === right.screenWidth &&
          left.screenHeight === right.screenHeight &&
          Math.abs(left.devicePixelRatio - right.devicePixelRatio) < 0.01) {
        return true;
      }
      return Math.abs(left.width - right.width) <= 8 &&
        Math.abs(left.height - right.height) <= 8 &&
        left.screenWidth === right.screenWidth &&
        left.screenHeight === right.screenHeight &&
        Math.abs(left.devicePixelRatio - right.devicePixelRatio) < 0.01 &&
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
      const rawX = optionalNumber(bridgeField(payload, "x", "x"));
      const rawY = optionalNumber(bridgeField(payload, "y", "y"));
      const sourceWidth = Number(bridgeField(payload, "sourceWidth", "source_width"));
      const sourceHeight = Number(bridgeField(payload, "sourceHeight", "source_height"));
      const coordinateSpace = String(bridgeField(payload, "coordinateSpace", "coordinate_space") || AppState.tobii.coordinateSpace || "unknown");
      const directMonotonicMilliseconds = optionalNumber(bridgeField(payload, "bridgeMonotonicMs", "bridge_monotonic_ms"));
      const monotonicMicroseconds = optionalNumber(bridgeField(payload, "monotonicTimestampMicroseconds", "monotonic_timestamp_microseconds"));
      const monotonicMilliseconds = directMonotonicMilliseconds ?? (monotonicMicroseconds === null ? null : monotonicMicroseconds / 1000);
      const deviceTimestampMicroseconds = optionalNumber(bridgeField(payload, "deviceTimestampMicroseconds", "device_timestamp_microseconds"));
      const clockOffsetMs = AppState.tobii.activeTrial.clockOffsetMs;
      const samplePerformanceMs = deviceTimestampMicroseconds !== null && clockOffsetMs != null
        ? deviceTimestampMicroseconds / 1000 + clockOffsetMs : receivedAt;
      let x = rawX;
      let y = rawY;
      let mapping = "direct";
      if (coordinateSpace === "screen_normalized") {
        const offsetX = optionalNumber(payload.viewportOffsetX);
        const offsetY = optionalNumber(payload.viewportOffsetY);
        const viewportWidth = optionalNumber(payload.viewportWidth);
        const viewportHeight = optionalNumber(payload.viewportHeight);
        const hasGeometry = sourceWidth > 0 && sourceHeight > 0 && offsetX !== null && offsetY !== null && viewportWidth > 0 && viewportHeight > 0;
        x = hasGeometry && rawX !== null ? (rawX * sourceWidth - offsetX) * window.innerWidth / viewportWidth : null;
        y = hasGeometry && rawY !== null ? (rawY * sourceHeight - offsetY) * window.innerHeight / viewportHeight : null;
        mapping = "screen_to_css_viewport";
      } else if (coordinateSpace === "viewport_normalized" || coordinateSpace === "normalized") {
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
        sample_performance_ms: samplePerformanceMs,
        transport_delay_ms: clockOffsetMs != null ? round(receivedAt - samplePerformanceMs, 3) : null,
        clock_mapping: clockOffsetMs != null ? "tobii_system_clock_to_browser" : "browser_receipt_time",
        raw_x: rawX,
        raw_y: rawY,
        x: Number.isFinite(x) ? round(x, 3) : null,
        y: Number.isFinite(y) ? round(y, 3) : null,
        valid: bridgeField(payload, "valid", "valid") !== false && Number.isFinite(rawX) && Number.isFinite(rawY) && Number.isFinite(x) && Number.isFinite(y),
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
      if (active.samples.length >= MAX_GAZE_SAMPLES_PER_TRIAL) {
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
        if (typeof payload.connected === "boolean") {
          const wasConnected = AppState.tobii.connected;
          AppState.tobii.connected = payload.connected;
          AppState.tobii.status = payload.connected ? "connected" : "disconnected";
          AppState.tobii.lastError = payload.lastError || null;
          if (wasConnected && !payload.connected) notifyTobiiDisconnected(payload.lastError || "The Tobii connection was lost.");
        }
        const provider = bridgeField(payload, "provider", "provider");
        AppState.tobii.provider = provider && typeof provider === "object"
          ? (bridgeField(provider, "providerDisplayName", "provider_display_name") || bridgeField(provider, "providerId", "provider_id") || null)
          : provider || payload.deviceName || null;
        AppState.tobii.providerMode = provider && typeof provider === "object"
          ? (bridgeField(provider, "providerId", "provider_id") || null)
          : (bridgeField(payload, "providerMode", "provider_mode") || (payload.simulated === true ? "simulator" : payload.simulated === false ? "native" : provider || null));
        AppState.tobii.coordinateSpace = bridgeField(payload, "coordinateSpace", "coordinate_space") || null;
        refreshTobiiStatus();
        return;
      }
      if (payload.type === "authenticated") {
        AppState.tobii.providerMode = bridgeField(payload, "provider", "provider") || AppState.tobii.providerMode;
        return;
      }
      if (payload.type === "gaze") {
        AppState.tobii.receivedSamples += 1;
        AppState.tobii.lastGazeAt = performance.now();
        if (payload.valid !== false && optionalNumber(payload.x) !== null && optionalNumber(payload.y) !== null) {
          AppState.tobii.validSamples += 1;
          AppState.tobii.lastValidGazeAt = AppState.tobii.lastGazeAt;
        }
        recordTobiiSample(payload);
        refreshTobiiStatus();
      }
    }

    // The native listener must share the trial recorder's closure.
    window.handleNativeTobiiMessage = handleTobiiPayload;

    function refreshTobiiStatus() {
      if (AppState.eyeTracking.source !== EYE_SOURCE_TOBII) return;
      const button = document.querySelector("[data-open-eye-tracking]");
      if (button) button.textContent = eyeTrackingStatusText();
      const output = document.querySelector("#eye-tracking-status");
      if (output && document.querySelector("#eye-tracking-source")?.value === EYE_SOURCE_TOBII) output.textContent = tobiiStatusText();
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
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => { timer = window.setTimeout(
          () => reject(new Error("Connection timed out. Start the Tobii Bridge and try again.")),
          timeoutMs
        ); })
      ]).finally(() => window.clearTimeout(timer));
    }

    async function synchronizeNativeTobiiClock(timeoutMs) {
      let best = null;
      for (let i = 0; i < 5; i++) {
        const sentAt = performance.now();
        const clock = JSON.parse(await withConnectionTimeout(nativeBridge.GetClockJson(), timeoutMs));
        const receivedAt = performance.now();
        const hostUs = optionalNumber(clock.systemTimestampMicroseconds);
        if (hostUs === null || hostUs <= 0) throw new Error("Tobii returned an invalid clock timestamp.");
        const roundTripMs = receivedAt - sentAt;
        if (!best || roundTripMs < best.roundTripMs) {
          best = { roundTripMs, offsetMs: (sentAt + receivedAt) / 2 - hostUs / 1000 };
        }
      }
      AppState.tobii.clockOffsetMs = best.offsetMs;
      AppState.tobii.clockUncertaintyMs = best.roundTripMs / 2;
    }

    function connectTobiiBridge(timeoutMs = 4000) {
      if (nativeBridge) {
        return (async () => {
          try {
            const status = JSON.parse(await withConnectionTimeout(nativeBridge.GetStatusJson(), timeoutMs));
            handleTobiiPayload({ ...status, type: "status" });
            if (AppState.tobii.connected) await synchronizeNativeTobiiClock(timeoutMs);
            return AppState.tobii.connected;
          } catch (error) {
            AppState.tobii.connected = false;
            AppState.tobii.status = "disconnected";
            AppState.tobii.clockOffsetMs = null;
            AppState.tobii.lastError = error.message || "Could not read the native Tobii status.";
            return false;
          }
        })();
      }
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
        clockOffsetMs: AppState.tobii.clockOffsetMs,
        clockUncertaintyMs: AppState.tobii.clockUncertaintyMs,
        samples: [],
        lastAcceptedClock: null,
        downsampled: 0,
        overflow: 0,
        lastSampleTsUs: null,
        totalBlinkMs: 0,
        totalValidMs: 0,
        totalInThreshMs: 0,
        missingDurationMs: 0,
        rejectedTimestampSamples: 0,
        synchronousRecords: [],
        onSample: null
      };
      return AppState.tobii.activeTrial;
    }

    function finishTobiiTrial(sessionId) {
      const active = AppState.tobii.activeTrial;
      AppState.tobii.activeTrial = null;
      if (!active || active.sessionId !== sessionId) {
        return { samples: [], downsampled: 0, overflow: 0, synchronousRecords: [], totalBlinkMs: 0, totalValidMs: 0, totalInThreshMs: 0, accuracyRate: null };
      }
      const validMs = active.totalValidMs || 0;
      const inThreshMs = active.totalInThreshMs || 0;
      const accRate = validMs > 0 ? round((inThreshMs / validMs) * 100, 2) : null;
      return {
        samples: active.samples,
        downsampled: active.downsampled,
        overflow: active.overflow,
        synchronousRecords: active.synchronousRecords || [],
        totalBlinkMs: round(active.totalBlinkMs || 0, 2),
        totalValidMs: round(validMs, 2),
        totalInThreshMs: round(inThreshMs, 2),
        clockUncertaintyMs: active.clockUncertaintyMs,
        missingDurationMs: round(active.missingDurationMs, 2),
        rejectedTimestampSamples: active.rejectedTimestampSamples,
        accuracyRate: accRate
      };
    }

    function beginWebGazerTrial(sessionId) {
      AppState.webgazerActiveTrial = {
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
        missingDurationMs: 0,
        rejectedTimestampSamples: 0,
        synchronousRecords: [],
        onSample: null
      };
      return AppState.webgazerActiveTrial;
    }

    function finishWebGazerTrial(sessionId) {
      const active = AppState.webgazerActiveTrial;
      AppState.webgazerActiveTrial = null;
      if (!active || active.sessionId !== sessionId) {
        return { samples: [], downsampled: 0, overflow: 0, synchronousRecords: [], totalBlinkMs: 0, totalValidMs: 0, totalInThreshMs: 0, accuracyRate: null };
      }
      const validMs = active.totalValidMs || 0;
      const inThreshMs = active.totalInThreshMs || 0;
      const accRate = validMs > 0 ? round((inThreshMs / validMs) * 100, 2) : null;
      return {
        samples: active.samples,
        downsampled: active.downsampled,
        overflow: active.overflow,
        synchronousRecords: active.synchronousRecords || [],
        totalBlinkMs: round(active.totalBlinkMs || 0, 2),
        totalValidMs: round(validMs, 2),
        totalInThreshMs: round(inThreshMs, 2),
        missingDurationMs: round(active.missingDurationMs || 0, 2),
        rejectedTimestampSamples: active.rejectedTimestampSamples || 0,
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
          <div class="patient-notice">Authorized visual rehabilitation training system.</div>
        </header>`;
    }

    class CalibrationPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement) {
        displayElement.innerHTML = `
          <section class="app-page">
            <div class="app-shell">
              ${appTopbar()}
              <p class="eyebrow">Initial setup</p>
              <h1>Distance Setting</h1>
              <p class="lede">Seat the participant directly in front of the screen with their eyes aligned to its center. These measurements convert visual angle settings into screen pixels.</p>
              <div class="setup-layout">
                <section class="panel form-panel">
                  <div class="panel-heading">
                    <div><h2>Display & Distance</h2><p>Measure the display currently in use.</p></div>
                  </div>
                  <form id="calibration-form">
                    <div class="field">
                      <label for="initial-subject-id">Subject ID</label>
                      <div class="input-wrap">
                        <input id="initial-subject-id" name="subjectId" type="text" value="${escapeHtml(subjectId || '')}" placeholder="Enter participant ID (e.g., P001, A01)..." autocomplete="off" />
                      </div>
                      <p class="field-hint">Participant identifier recorded in all exported session reports</p>
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
                    <p class="option-note">WebGazer uses camera positioning and nine-point calibration. Tobii uses hardware tracking configured in Tobii Experience. Both feature a 5-point validation step that dynamically calibrates the hit threshold.</p>
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
          const sourceReady = await setEyeTrackingSource(eyeTrackingSource);
          if (eyeTrackingSource === EYE_SOURCE_TOBII && !sourceReady) {
            setError(error, tobiiStatusText());
            return;
          }
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
            <label for="subject-id-input" class="subject-id-title">Subject ID / Code</label>
            <span class="subject-id-subtitle">Participant identifier recorded in trial metadata and CSV filenames</span>
          </div>
          <div class="subject-id-input-group">
            <input type="text" id="subject-id-input" class="subject-id-input" value="${escapeHtml(currentId || '')}" placeholder="Enter Subject ID (e.g., P001, A01)..." autocomplete="off" />
            <button type="button" id="subject-id-refresh-btn" class="secondary-button subject-id-refresh-btn" title="Generate random Subject ID">Generate ID</button>
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
        duration_complete: "Duration complete",
        evaluation_complete: "Evaluation complete",
        escape: "Interrupted by user (ESC)",
        fullscreen_exit: "Fullscreen exited",
        visibility_hidden: "Window hidden",
        viewport_changed: "Viewport changed",
        invalid_geometry: "Target exceeded viewport boundaries",
        eye_tracker_disconnected: "Eye tracker disconnected",
        eye_tracker_unavailable: "Eye tracker unavailable",
        fullscreen_required: "Fullscreen is required for training"
      };
      const module = MODULES[session.module] || { code: session.module };
      const acc = session.accuracy_rate != null ? `${session.accuracy_rate}%` : "N/A (no valid gaze)";
      const inSec = session.in_threshold_sec !== undefined ? `${session.in_threshold_sec}s` : "-";
      const validSec = session.valid_sec !== undefined ? `${session.valid_sec}s` : "-";
      return `
        <div class="session-banner ${completed ? "" : "is-aborted"}">
          <div class="session-copy">
            <div>
              <strong>${module.code} ${completed ? "Session Completed" : "Session Interrupted"} · Accuracy: <span style="color:var(--lime, #63e6ff); font-size:1.15em; font-weight:900;">${acc}</span></strong>
              <span>${reasonLabels[session.end_reason] || session.end_reason} · In-target: <strong>${inSec}</strong> / Valid: <strong>${validSec}</strong> · Threshold: ${session.threshold_deg || 1.5}°</span>
              ${session.module === "saccade" ? `<span>Mean TFF: <strong>${session.tff_mean_ms != null ? session.tff_mean_ms + " ms" : "N/A"}</strong> · Detected: ${session.tff_detected_targets || 0} / ${session.tff_total_targets || 0} targets</span>` : ""}
              <span data-save-status style="color:var(--muted, #888); font-size:12px;">${window.OcuTrainDesktop ? desktopSaveStatus() : "CSV report downloaded"}</span>
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-shrink:0;">
            <button class="ghost-button" type="button" data-open-data-folder>Open Data Folder</button>
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

      // 1. Test Mode
      const mode = isVor ? "" : `
        <div class="field span-all">
          <label for="module-mode">Test Mode</label>
          <select id="module-mode" name="mode" required>${modeOptions(settings.mode)}</select>
          <p id="mode-hint" class="field-hint"></p>
        </div>`;

      // 2. Stimulus Type
      const stimField = isVor ? "" : `
        <div class="field span-all" style="margin-top: 2px;">
          <label class="field-label" style="display:block; margin-bottom:6px;">Stimulus Type</label>
          <input type="hidden" name="stimulusType" id="module-stimulus-type" value="${stimType}">
          <div class="training-option-grid training-option-grid-three" id="stimulus-type-grid">
            <button type="button" class="training-option ${stimType === 'white_dot' ? 'active' : ''}" data-stim-type="white_dot">
              <span class="training-option-title">White dot</span>
              <span class="training-option-meta">Standard solid white dot</span>
            </button>
            <button type="button" class="training-option ${stimType === 'red_in_white' ? 'active' : ''}" data-stim-type="red_in_white">
              <span class="training-option-title">Red in White</span>
              <span class="training-option-meta">White circle with red center</span>
            </button>
            <button type="button" class="training-option ${stimType === 'numbers_dot' ? 'active' : ''}" data-stim-type="numbers_dot">
              <span class="training-option-title">Numbers dot</span>
              <span class="training-option-meta">Dynamic numbers & colors</span>
            </button>
          </div>
        </div>`;

      // 3. Target Size
      const sizeSlider = `
        <div class="field span-all" style="margin-top: 4px;">
          <div class="slider-card" style="margin-top: 0;">
            <div class="slider-card-header">
              <span class="slider-card-title">Target Size</span>
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
          <label for="ball-arcmin">Target Visual Angle (arcmin)</label>
          <div class="input-wrap">
            <input id="ball-arcmin" name="ballArcmin" data-label="Target Visual Angle (arcmin)" type="number" min="1" max="600" step="1" inputmode="decimal" value="${currentArcmin}" required>
            <span class="unit">' (arcmin)</span>
          </div>
          <p class="field-hint">1° = 60 arcminutes</p>
        </div>`;

      // 4. Hit Distance Threshold
      const currentThreshArcmin = Number(settings.distanceThresholdArcmin) || 90;
      const currentThreshDeg = (currentThreshArcmin / 60).toFixed(2);
      const thresholdSlider = `
        <div class="field span-all" style="margin-top: 4px;">
          <div class="slider-card" style="margin-top: 0;">
            <div class="slider-card-header">
              <span class="slider-card-title">Hit Distance Threshold</span>
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
          <label for="threshold-arcmin">Distance Threshold (arcmin)</label>
          <div class="input-wrap">
            <input id="threshold-arcmin" name="distanceThresholdArcmin" data-label="Distance Threshold (arcmin)" type="number" min="10" max="600" step="1" inputmode="decimal" value="${currentThreshArcmin}" required>
            <span class="unit">' (arcmin)</span>
          </div>
          <p class="field-hint">Tobii adds a ${TOBII_ERROR_ALLOWANCE_DEG}° measurement-error allowance to this setting; WebGazer adds ${WEBGAZER_ERROR_ALLOWANCE_DEG}°. A larger 5-point validation threshold takes precedence.</p>
        </div>`;

      let paramFields = "";
      if (moduleKey === "vor") {
        paramFields = `${sizeSlider}${thresholdSlider}
          ${numberField({ id: "change-ms", name: "changeMs", label: "Shift Interval (ms)", value: settings.changeMs, unit: "ms", hint: "Interval between digit and color changes", step: "1" })}
          ${numberField({ id: "total-sec", name: "totalSec", label: "Total Duration (s)", value: settings.totalSec, unit: "sec", hint: "Session stops automatically when completed", step: "0.1" })}`;
      } else if (moduleKey === "saccade") {
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}
          ${numberField({ id: "dwell-ms", name: "dwellMs", label: "Target Dwell Time (ms)", value: settings.dwellMs, unit: "ms", hint: "Target duration at each grid position", step: "1" })}
          ${numberField({ id: "total-sec", name: "totalSec", label: "Total Duration (s)", value: settings.totalSec, unit: "sec", hint: "Ignored in Evaluation mode", step: "0.1" })}`;
      } else if (moduleKey === "pursuit") {
        const speed = numberField({
          id: "speed-arcmin", name: "speedArcminSec", label: "Target Speed (arcmin/s)", value: settings.speedArcminSec,
          unit: "arcmin/sec", hint: "Linear movement angular velocity", step: "0.1"
        });
        const total = numberField({
          id: "total-sec", name: "totalSec", label: "Total Duration (s)", value: settings.totalSec,
          unit: "sec", hint: "Ignored in Evaluation mode", step: "0.1"
        });
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}${speed}${total}`;
      } else if (moduleKey === "fixation") {
        const speed = numberField({
          id: "speed-arcmin", name: "speedArcminSec", label: "Target Speed (arcmin/s)", value: settings.speedArcminSec,
          unit: "arcmin/sec", hint: "Movement speed toward screen edge", step: "0.1"
        });
        const hold = numberField({
          id: "hold-sec", name: "holdSec", label: "Edge Hold Time (s)", value: settings.holdSec,
          unit: "sec", hint: "Hold fixation duration at edge", step: "0.1"
        });
        const total = numberField({
          id: "total-sec", name: "totalSec", label: "Total Duration (s)", value: settings.totalSec,
          unit: "sec", hint: "Ignored in Evaluation mode", step: "0.1"
        });
        paramFields = `${mode}${stimField}${sizeSlider}${thresholdSlider}${speed}${hold}${total}`;
      }

      // 4. Movement Directions
      const directionsField = isVor ? "" : `
        <div class="field span-all" style="margin-top: 6px;">
          <input type="hidden" name="directions" id="module-directions" value='${JSON.stringify(currentDirs)}'>
          <div class="training-setting-header">
            <div>
              <label class="field-label" style="font-size:13.5px; font-weight:800; color:#fff; display:block; margin-bottom:2px;">Movement Directions</label>
              <p class="training-setting-description">Spatial compass grid: click directions to toggle, or click center to toggle all.</p>
            </div>
            <span id="badge-directions" class="slider-value-pill">${currentDirs.length}/8 Directions Active</span>
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
                    <span class="direction-btn-label">ALL</span>
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
          result.errors.push("Directions (enable at least one direction)");
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
            <div><p class="eyebrow">${module.code} setup</p><h2 id="module-dialog-title">${module.name} settings</h2><p>${module.short} · Subject ID: <strong style="color:var(--text); font-weight:700;">${escapeHtml(subjectId || '-')}</strong></p></div>
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

      // 1. Stimulus type toggle
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

        // 2. Compass 9-grid direction selection
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
              badgeEl.textContent = `${selectedDirs.length}/8 directions enabled`;
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

      // 3. Target size slider & input synchronization
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

      // 4. Threshold slider & input synchronization
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

      const stimLabel = stimNames[stimType] || stimType;
      let modeText = "";
      if (moduleKey === "vor") {
        modeText = `Central target identification · ${settings.values.changeMs} ms / step`;
      } else {
        const dirCountText = `${dirs.length}/8 directions enabled`;
        if (mode === EVALUATION) {
          modeText = moduleKey === "saccade"
            ? `Evaluation (fixed ${SACCADE_SEQUENCE.length} targets; selected directions only) · ${stimLabel}`
            : `Evaluation (${dirs.length} directions × 2 rounds) · ${stimLabel}`;
        } else if (mode === PREDICTABLE) {
          modeText = `Predictable (${dirCountText}) · ${stimLabel}`;
        } else {
          modeText = `Random (${dirCountText}) · ${stimLabel}`;
        }
      }

      output.innerHTML = `
        <span>${modeText}<br>Visual angle ${arcmin}' (${deg.toFixed(2)}°) · Diameter ${formatNumber(size.diameterCm, 3)} cm</span>
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
            .then(async () => {
              if (window.OcuTrainDesktop) await window.OcuTrainDesktop.FullscreenReady();
              return Boolean(document.fullscreenElement);
            })
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
      if (window.OcuTrainDesktop) {
        return saveDesktopDocument(filename, JSON.stringify(data, null, 2));
      }
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
                  <button class="secondary-button" type="button" data-open-calibration>Distance Setting</button>
                  <button class="secondary-button" type="button" data-open-help>Instructions</button>
                  <button class="secondary-button" type="button" data-run-webgazer-calib>Calibration</button>
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
            <div class="dialog-header"><div><p class="eyebrow">Display Setup</p><h2 id="recalibration-title">Distance Setting</h2></div><button class="icon-button" type="button" data-close-calibration aria-label="Close">×</button></div>
            <div class="dialog-body">
              <form id="recalibration-form">
                ${calibrationFields(AppState.calibration)}
                <div id="recalibration-output" style="margin-top:18px"></div>
                <p id="recalibration-error" class="form-error" role="alert"></p>
                <div class="dialog-actions"><button class="ghost-button" type="button" data-close-calibration>Cancel</button><button class="primary-button" type="submit">Save settings</button></div>
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
                <label class="option-row" for="tobii-revalidate">
                  <input id="tobii-revalidate" name="tobiiRevalidate" type="checkbox" ${AppState.tobii.needsRevalidation ? "checked" : ""}>
                  <span>Run 5-point gaze validation before the next Tobii training session</span>
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
        const tobiiRevalidateInput = eyeTrackingForm.elements.namedItem("tobiiRevalidate");
        const eyeTrackingStatus = displayElement.querySelector("#eye-tracking-status");
        const eyeTrackingSourceNote = displayElement.querySelector("#eye-tracking-source-note");
        const syncEyeTrackingForm = () => {
          const source = String(eyeTrackingSourceInput.value || EYE_SOURCE_OFF);
          const webgazerSelected = source === EYE_SOURCE_WEBGAZER;
          const tobiiSelected = source === EYE_SOURCE_TOBII;
          const calibrationIsRequired = webgazerSelected && !AppState.eyeTracking.calibrated;
          eyeTrackingRecalibrateInput.disabled = !webgazerSelected || calibrationIsRequired;
          tobiiCalibratedInput.disabled = !tobiiSelected;
          if (tobiiRevalidateInput) tobiiRevalidateInput.disabled = !tobiiSelected;
          if (!webgazerSelected) eyeTrackingRecalibrateInput.checked = false;
          if (calibrationIsRequired) eyeTrackingRecalibrateInput.checked = true;
          eyeTrackingSourceNote.textContent = webgazerSelected
            ? "Camera video is processed locally. Only gaze coordinates are added to the current session data."
            : tobiiSelected
              ? "Tobii calibration is performed in Tobii Experience, not in this browser. A 5-point validation establishes the dynamic hit threshold before training."
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
          if (source === EYE_SOURCE_TOBII && tobiiRevalidateInput && tobiiRevalidateInput.checked) {
            AppState.tobii.needsRevalidation = true;
            AppState.tobii.validated = false;
          }
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
          AppState.eyeTracking.lastValidation = null;
          AppState.eyeTracking.calibrated = false;
          AppState.eyeTracking.calibrationRequested = AppState.eyeTracking.source === EYE_SOURCE_WEBGAZER;
          AppState.tobii.validated = false;
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
            if (window.OcuTrainDesktop && AppState.lastCsvReport) {
              saveDesktopDocument(AppState.lastCsvReport.filename, AppState.lastCsvReport.content);
              return;
            }
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const sid = AppState.lastSession && AppState.lastSession.session_id;
            const dataObj = sid ? window.jsPsychInstance.data.get().filter({ session_id: sid }) : window.jsPsychInstance.data.get();
            const csvData = dataObj.csv();
            triggerFileDownload(`${subjectId}_eye-training-${AppState.lastSession.module}-${stamp}.csv`, csvData);
          });
        }

        const openDataFolderBtn = displayElement.querySelector("[data-open-data-folder]");
        if (openDataFolderBtn) {
          openDataFolderBtn.addEventListener("click", () => {
            if (window.OcuTrainDesktop) {
              window.OcuTrainDesktop.OpenDataFolder().catch(error => alert(`Could not open Data folder: ${error}`));
            } else {
              alert("Local Data/ folder is located in the application directory under Data.");
            }
          });
        }

        const runWebgazerCalibBtn = displayElement.querySelector("[data-run-webgazer-calib]");
        if (runWebgazerCalibBtn) {
          runWebgazerCalibBtn.addEventListener("click", () => {
            if (!AppState.eyeTracking.available) {
              alert("WebGazer tracking component is not yet loaded. Please connect to the internet or reload.");
              return;
            }
            requestFullscreenSafely().then((fullscreenEntered) => {
              AppState.pending = {
                module: "vor",
                settings: { ...MODULE_DEFAULTS.vor },
                calibration: { ...AppState.calibration },
                fullscreenEntered: Boolean(fullscreenEntered),
                setupViewport: currentViewportSignature(),
                eyeTrackingEnabled: true,
                eyeTrackingSource: EYE_SOURCE_WEBGAZER,
                calibrateOnly: true
              };
              AppState.eyeTracking.source = EYE_SOURCE_WEBGAZER;
              AppState.eyeTracking.enabled = true;
              AppState.eyeTracking.calibrationRequested = true;
              AppState.eyeTracking.needsRecalibration = true;
              this.jsPsych.finishTrial({
                action: "webgazer_calibration_direct_launch",
                fullscreen_entered: Boolean(fullscreenEntered)
              });
            });
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
                if (eyeTrackingSource === EYE_SOURCE_TOBII) {
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
          clean();
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

        displayElement.innerHTML = `
          <section class="app-page">
            <div class="app-shell" style="max-width:760px" role="status" aria-live="polite">
              <p class="eyebrow">WebGazer setup</p>
              <h1>Starting camera</h1>
              <p class="lede">Preparing the camera and local eye tracking models. Please wait. First use may take longer.</p>
            </div>
          </section>`;
        signalLoad();

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

    class GazeValidationPlugin {
      constructor(jsPsych) { this.jsPsych = jsPsych; }

      trial(displayElement, trial, onLoad) {
        if (typeof onLoad === "function") onLoad();
        const activeSource = (AppState.pending && AppState.pending.eyeTrackingSource) || AppState.eyeTracking.source;
        const isTobii = activeSource === EYE_SOURCE_TOBII;
        const isWebGazer = activeSource === EYE_SOURCE_WEBGAZER;
        const extension = this.jsPsych.extensions && this.jsPsych.extensions.webgazer;
        const calibration = AppState.calibration || { screenWidthCm: 50, screenHeightCm: 28, viewingDistanceCm: 60 };
        const screenPixels = currentScreenPixels();

        if (isWebGazer) {
          try {
            if (extension) {
              extension.hideVideo();
              extension.hidePredictions();
              extension.resume();
            }
          } catch (e) {}
        }

        const validationPoints = [
          { xRatio: 0.50, yRatio: 0.50, label: "Center" },
          { xRatio: 0.20, yRatio: 0.20, label: "Top-Left" },
          { xRatio: 0.80, yRatio: 0.20, label: "Top-Right" },
          { xRatio: 0.20, yRatio: 0.80, label: "Bottom-Left" },
          { xRatio: 0.80, yRatio: 0.80, label: "Bottom-Right" }
        ];

        let pointIndex = 0;
        let pointResults = [];
        let currentSamples = [];
        let pointTimer = null;
        let isCollecting = false;
        let countdownInterval = null;
        let ended = false;
        let unsubscribe = null;
        if (isWebGazer && extension && typeof extension.onGazeUpdate === "function") {
          unsubscribe = extension.onGazeUpdate((prediction) => {
            if (ended || !isCollecting) return;
            if (prediction && Number.isFinite(prediction.x) && Number.isFinite(prediction.y)) {
              currentSamples.push({ x: prediction.x, y: prediction.y });
            }
          });
        }

        if (isTobii) {
          const capture = beginTobiiTrial("validation");
          capture.onSample = (sample) => {
            if (ended || !isCollecting) return;
            if (sample && sample.valid && Number.isFinite(sample.x) && Number.isFinite(sample.y)) {
              currentSamples.push({ x: sample.x, y: sample.y });
            }
          };
        }

        const cleanUp = () => {
          ended = true;
          if (pointTimer !== null) clearTimeout(pointTimer);
          if (countdownInterval !== null) clearInterval(countdownInterval);
          if (isWebGazer && extension) {
            try { extension.pause(); } catch (error) { /* Continue cleanup. */ }
          }
          if (unsubscribe) {
            try { unsubscribe(); } catch (e) {}
            unsubscribe = null;
          }
          if (isTobii) {
            AppState.tobii.activeTrial = null;
          }
          document.removeEventListener("keydown", onKeyDown);
        };

        const onKeyDown = (e) => {
          if (e.key === "Escape") {
            cleanUp();
            void exitFullscreenSafely();
            AppState.pending = null;
            AppState.eyeTracking.needsRecalibration = false;
            if (isTobii) AppState.tobii.needsRevalidation = false;
            this.jsPsych.finishTrial({ action: "validation_aborted", aborted: true });
          }
        };
        document.addEventListener("keydown", onKeyDown);

        const runPoint = (idx) => {
          if (idx >= validationPoints.length) {
            showResults();
            return;
          }
          pointIndex = idx;
          currentSamples = [];
          isCollecting = false;
          const pt = validationPoints[idx];
          const tx = Math.round(window.innerWidth * pt.xRatio);
          const ty = Math.round(window.innerHeight * pt.yRatio);

          displayElement.innerHTML = `
            <div id="webgazer-validate-container">
              <div class="webgazer-validate-instruction">
                Gaze Accuracy Validation: Look directly at the target (${idx + 1} / 5)
              </div>
              <div class="webgazer-validate-target" style="left: ${tx}px; top: ${ty}px;">
                <div class="webgazer-validate-target-inner"></div>
              </div>
            </div>`;

          pointTimer = setTimeout(() => {
            isCollecting = true;
            pointTimer = setTimeout(() => {
              isCollecting = false;
              if (currentSamples.length > 0) {
                const xs = currentSamples.map((s) => s.x).sort((a, b) => a - b);
                const ys = currentSamples.map((s) => s.y).sort((a, b) => a - b);
                const medX = xs[Math.floor(xs.length / 2)];
                const medY = ys[Math.floor(ys.length / 2)];
                const distPx = Math.hypot(medX - tx, medY - ty);
                const distDeg = gazeErrorDegrees(medX - tx, medY - ty, calibration, screenPixels);
                pointResults.push({
                  label: pt.label,
                  tx,
                  ty,
                  medX,
                  medY,
                  distPx: round(distPx, 1),
                  distDeg: round(distDeg, 2),
                  sampleCount: currentSamples.length
                });
              } else {
                pointResults.push({
                  label: pt.label,
                  tx,
                  ty,
                  medX: null,
                  medY: null,
                  distPx: null,
                  distDeg: null,
                  sampleCount: 0
                });
              }
              runPoint(idx + 1);
            }, 1050);
          }, 350);
        };

        const showResults = () => {
          cleanUp();
          const validPoints = pointResults.filter((p) => p.sampleCount >= 3);
          const hasEnoughData = validPoints.length >= 3;
          const meanErrorDeg = validPoints.length > 0
            ? round(validPoints.reduce((sum, p) => sum + p.distDeg, 0) / validPoints.length, 2)
            : null;
          const PASS_THRESHOLD_DEG = isTobii ? 3.0 : 3.5;
          const passed = hasEnoughData && meanErrorDeg <= PASS_THRESHOLD_DEG;
          const dynamicThresholdDeg = hasEnoughData ? round(Math.max(0.5, meanErrorDeg * 2), 2) : null;
          const thresholdPreview = gazeThresholds(activeSource, AppState.pending?.settings || {}, { source: activeSource, dynamicThresholdDeg });
          const effectiveThresholdArcmin = round(thresholdPreview.effectiveDeg * 60, 1);

          const isCalibrateOnly = Boolean(AppState.pending && AppState.pending.calibrateOnly);
          const sourceName = isTobii ? "Tobii Eye Tracker 5" : "WebGazer";

          let actionButtonsHtml = "";
          let noticeHtml = "";

          if (!hasEnoughData) {
            noticeHtml = `<p style="color:#f87171; font-size:14px; margin-bottom:18px;">Insufficient valid gaze data (${validPoints.length}/5 targets). Check that both eyes are detected in ${isTobii ? "Tobii Experience" : "the camera"}, then re-validate. Accuracy cannot be calculated.</p>`;
            actionButtonsHtml = `
              <button class="primary-button" type="button" data-val-action="recalib">Re-validate</button>
              <button class="secondary-button" type="button" data-val-action="done">Return to Menu</button>`;
          } else if (isCalibrateOnly) {
            if (passed) {
              noticeHtml = `<p style="color:var(--lime, #63e6ff); font-size:14px; margin-bottom:18px;">Validation passed. Gaze tracking precision verified and ready.</p>`;
              actionButtonsHtml = `
                <button class="primary-button" type="button" data-val-action="done">Complete & Return to Menu</button>
                <button class="secondary-button" type="button" data-val-action="recalib">${isTobii ? "Re-validate" : "Recalibrate"}</button>`;
            } else {
              noticeHtml = `<p style="color:#f87171; font-size:14px; margin-bottom:18px;">Average angular error (${meanErrorDeg}°) exceeds target threshold (${PASS_THRESHOLD_DEG}°). Recalibration is recommended.</p>`;
              actionButtonsHtml = `
                <button class="primary-button" type="button" data-val-action="recalib">${isTobii ? "Re-validate" : "Recalibrate"}</button>
                <button class="secondary-button" type="button" data-val-action="done">Skip & Return to Menu</button>`;
            }
          } else {
            if (passed) {
              noticeHtml = `<p style="color:var(--lime, #63e6ff); font-size:14px; margin-bottom:18px;">Validation passed. Effective hit threshold: ${thresholdPreview.effectiveDeg}°, including a ${thresholdPreview.allowanceDeg}° ${sourceName} measurement-error allowance where needed. Starting training...</p>`;
              actionButtonsHtml = `
                <button class="primary-button" type="button" data-val-action="proceed">Start Training (<span id="val-cd-num">3</span>s)</button>
                <button class="secondary-button" type="button" data-val-action="recalib">${isTobii ? "Re-validate" : "Recalibrate"}</button>`;
            } else {
              noticeHtml = `<p style="color:#f87171; font-size:14px; margin-bottom:18px;">Validation error higher than recommended (${meanErrorDeg}° > ${PASS_THRESHOLD_DEG}°). You may re-validate or proceed with the effective threshold (${thresholdPreview.effectiveDeg}°).</p>`;
              actionButtonsHtml = `
                <button class="primary-button" type="button" data-val-action="recalib">${isTobii ? "Re-validate" : "Recalibrate"}</button>
                <button class="secondary-button" type="button" data-val-action="proceed">Proceed Anyway</button>`;
            }
          }

          displayElement.innerHTML = `
            <div id="webgazer-validate-container">
              <div class="webgazer-validate-card">
                <p class="eyebrow" style="color:var(--cyan, #63e6ff); text-transform:uppercase; font-size:12px; font-weight:700; letter-spacing:0.08em; margin-bottom:6px;">${sourceName} Validation</p>
                <h2>Gaze Tracking Accuracy</h2>
                <p style="margin-bottom:16px;">5-point fixation accuracy assessment completed:</p>
                ${noticeHtml}
                <div class="webgazer-validate-stat-grid">
                  <div class="webgazer-validate-stat-item">
                    <span class="webgazer-validate-stat-label">Mean Angular Error</span>
                    <span class="webgazer-validate-stat-value ${passed ? "pass" : "fail"}">${meanErrorDeg === null ? "N/A" : meanErrorDeg + "°"}</span>
                  </div>
                  <div class="webgazer-validate-stat-item">
                    <span class="webgazer-validate-stat-label">Effective Hit Threshold (includes ${thresholdPreview.allowanceDeg}° allowance)</span>
                    <span class="webgazer-validate-stat-value ${hasEnoughData ? "pass" : "fail"}">${hasEnoughData ? `${thresholdPreview.effectiveDeg}° (${effectiveThresholdArcmin}')` : "N/A"}</span>
                  </div>
                  <div class="webgazer-validate-stat-item">
                    <span class="webgazer-validate-stat-label">Accuracy Status</span>
                    <span class="webgazer-validate-stat-value ${passed ? "pass" : "fail"}">${passed ? "Passed" : "Needs Attention"}</span>
                  </div>
                </div>

                <div style="font-size:13px; color:var(--muted, #94a3b8); margin-bottom:24px; background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:6px; border:1px solid rgba(255,255,255,0.06);">
                  <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
                    <span>Center: <strong>${pointResults[0]?.distDeg != null ? pointResults[0].distDeg + "°" : "No data"}</strong></span>
                    <span>Top-Left: <strong>${pointResults[1]?.distDeg != null ? pointResults[1].distDeg + "°" : "No data"}</strong></span>
                    <span>Top-Right: <strong>${pointResults[2]?.distDeg != null ? pointResults[2].distDeg + "°" : "No data"}</strong></span>
                  </div>
                  <div style="display:flex; justify-content:space-between; padding:4px 0;">
                    <span>Bottom-Left: <strong>${pointResults[3]?.distDeg != null ? pointResults[3].distDeg + "°" : "No data"}</strong></span>
                    <span>Bottom-Right: <strong>${pointResults[4]?.distDeg != null ? pointResults[4].distDeg + "°" : "No data"}</strong></span>
                    <span></span>
                  </div>
                </div>

                <div class="webgazer-validate-actions">
                  ${actionButtonsHtml}
                </div>
              </div>
            </div>`;

          const doneBtn = displayElement.querySelector("[data-val-action='done']");
          const proceedBtn = displayElement.querySelector("[data-val-action='proceed']");
          const recalibBtn = displayElement.querySelector("[data-val-action='recalib']");

          const finishSuccess = async (action) => {
            if (countdownInterval !== null) clearInterval(countdownInterval);
            if (isTobii) {
              AppState.tobii.validated = hasEnoughData;
              AppState.tobii.needsRevalidation = false;
            } else {
              AppState.eyeTracking.calibrated = hasEnoughData;
              AppState.eyeTracking.needsRecalibration = false;
              AppState.eyeTracking.calibrationRequested = false;
              AppState.eyeTracking.calibratedAt = AppState.eyeTracking.calibratedAt || new Date().toISOString();
              AppState.eyeTracking.calibrationViewport = currentViewportSignature();
            }
            AppState.eyeTracking.lastValidation = {
              source: activeSource,
              meanErrorDeg,
              dynamicThresholdDeg,
              passed,
              timestamp: new Date().toISOString()
            };
            if (isCalibrateOnly || !hasEnoughData) {
              AppState.pending = null;
              await exitFullscreenSafely();
            }
            this.jsPsych.finishTrial({
              action,
              passed,
              mean_error_deg: meanErrorDeg,
              dynamic_threshold_deg: dynamicThresholdDeg,
              point_results: pointResults
            });
          };

          const requestRecalibration = () => {
            if (countdownInterval !== null) clearInterval(countdownInterval);
            if (isTobii) {
              AppState.tobii.validated = false;
              AppState.tobii.needsRevalidation = true;
            } else {
              AppState.eyeTracking.calibrated = false;
              AppState.eyeTracking.needsRecalibration = true;
              AppState.eyeTracking.calibrationRequested = true;
            }
            this.jsPsych.finishTrial({
              action: isTobii ? "revalidation_requested" : "recalibration_requested",
              passed,
              mean_error_deg: meanErrorDeg,
              dynamic_threshold_deg: dynamicThresholdDeg,
              point_results: pointResults
            });
          };

          if (doneBtn) doneBtn.addEventListener("click", () => finishSuccess("validation_done"));
          if (proceedBtn) proceedBtn.addEventListener("click", () => finishSuccess("validation_proceed"));
          if (recalibBtn) recalibBtn.addEventListener("click", requestRecalibration);

          if (!isCalibrateOnly && passed) {
            let remainSec = 3;
            countdownInterval = setInterval(() => {
              remainSec -= 1;
              const cdNum = displayElement.querySelector("#val-cd-num");
              if (cdNum) cdNum.textContent = String(remainSec);
              if (remainSec <= 0) {
                clearInterval(countdownInterval);
                finishSuccess("validation_auto_proceed");
              }
            }, 1000);
          }
        };

        runPoint(0);
      }
    }

    GazeValidationPlugin.info = {
      name: "gaze-validation",
      version: "1.0.0",
      parameters: {},
      data: {
        action: { type: ParameterType.STRING },
        passed: { type: ParameterType.BOOL },
        mean_error_deg: { type: ParameterType.FLOAT },
        dynamic_threshold_deg: { type: ParameterType.FLOAT }
      }
    };

    const WebGazerValidationPlugin = GazeValidationPlugin;

    const DIRECTION_ENGLISH_LABELS = {
      rightUp: "Top-Right",
      leftUp: "Top-Left",
      rightDown: "Bottom-Right",
      leftDown: "Bottom-Left",
      middleUp: "Up",
      middleDown: "Down",
      leftMiddle: "Left",
      rightMiddle: "Right",
      center: "Center"
    };
    const DIRECTION_CHINESE_LABELS = DIRECTION_ENGLISH_LABELS;

    function csvEscape(value) {
      if (value === null || value === undefined) return '""';
      const str = String(value);
      return `"${str.replace(/"/g, '""')}"`;
    }

    function desktopSaveStatus() {
      const result = AppState.desktopSave;
      if (result?.error) return "Save failed. Use Export CSV to retry.";
      if (result?.path) return "Report saved to Data/ folder";
      return "Saving report to Data/ folder…";
    }

    async function saveDesktopDocument(filename, content) {
      const status = () => document.querySelector("[data-save-status]");
      const result = AppState.desktopSave = { filename, path: null, error: null };
      try {
        const path = await window.OcuTrainDesktop.SaveCsv(filename, content);
        result.path = path;
        if (status()) status().textContent = desktopSaveStatus();
        return path;
      } catch (error) {
        result.error = String(error);
        if (status()) status().textContent = desktopSaveStatus();
        alert(`Could not save ${filename}: ${error}. Keep this window open and use Export to retry.`);
        return null;
      }
    }

    function triggerFileDownload(filename, textContent) {
      if (window.OcuTrainDesktop) return saveDesktopDocument(filename, textContent);
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
        tobiiCapture,
        gazeCapture: inputGazeCapture
      } = trialData;

      const gazeCapture = inputGazeCapture || tobiiCapture || {};

      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const isoDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const isoTime = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const moduleCode = (MODULES[moduleKey] && MODULES[moduleKey].code) ? MODULES[moduleKey].code : moduleKey.toUpperCase();
      const moduleName = (MODULES[moduleKey] && MODULES[moduleKey].name) || moduleKey;

      const thresholdDetails = trialData.thresholdDetails || gazeThresholds(eyeTrackingSource, settings);
      const thresholdDeg = trialData.thresholdDeg !== undefined
        ? trialData.thresholdDeg
        : thresholdDetails.effectiveDeg;
      const thresholdArcmin = trialData.thresholdArcmin !== undefined
        ? trialData.thresholdArcmin
        : round(thresholdDeg * 60, 2);
      const thresholdPx = trialData.thresholdPx !== undefined
        ? trialData.thresholdPx
        : round(physicalSizeForArcmin(thresholdArcmin, calibration.viewingDistanceCm) * screenPixels.width / calibration.screenWidthCm, 1);
      const actualDurationMs = sessionStart === null ? 0 : endedAt - sessionStart;

      const totalValidMs = gazeCapture.totalValidMs || 0;
      const totalInThreshMs = gazeCapture.totalInThreshMs || 0;
      const totalBlinkMs = gazeCapture.totalBlinkMs || 0;
      const accuracyRate = gazeCapture.accuracyRate != null ? `${gazeCapture.accuracyRate} %` : "N/A (no valid gaze)";
      const records = gazeCapture.synchronousRecords || [];
      const tff = trialData.tff;
      const accuracyPhases = moduleKey === "pursuit" ? "Outward and return movement only; central cross excluded"
        : moduleKey === "fixation" ? "Edge hold only; central cross and movement excluded"
        : moduleKey === "saccade" ? "Existing scoring phases; first 200 ms of each target excluded" : "All valid tracking time";

      const deviceName = eyeTrackingSource === EYE_SOURCE_WEBGAZER
        ? "WebGazer (Webcam Eye Tracking)"
        : eyeTrackingSource === EYE_SOURCE_TOBII
          ? "Tobii Eye Tracker 5"
          : "None (Untracked)";

      const samplingRateText = eyeTrackingSource === EYE_SOURCE_WEBGAZER
        ? "~30 Hz (Dynamic Webcam Sampling)"
        : eyeTrackingSource === EYE_SOURCE_TOBII
          ? "Native SDK stream (source timestamps; no resampling)"
          : "N/A";

      const sourceTag = eyeTrackingSource === EYE_SOURCE_WEBGAZER ? "WebGazer" : eyeTrackingSource === EYE_SOURCE_TOBII ? "Tobii" : "Untracked";

      // File name: {SubjectID}_{Date8}_{Time6}_{ModuleCode}_{TrackerType}_gaze_record.csv
      const csvFilename = `${subjectId || "SUBJ"}_${dateStr}_${timeStr}_${moduleCode}_${sourceTag}_gaze_record.csv`;

      const selectedDirectionLabels = (selectedDirs || []).map(
        (dirKey) => DIRECTION_ENGLISH_LABELS[dirKey] || dirKey
      );

      // Metadata Headers
      const metaLines = [
        `# -- Oculomotor Rehabilitation Training System Test Report --`,
        `# Subject ID: ${subjectId || "-"}`,
        `# Session ID: ${sessionId}`,
        `# Test Date: ${isoDate}`,
        `# Test Time: ${isoTime}`,
        `# Training Module: ${moduleName} (${moduleCode})`,
        `# Test Mode: ${settings.mode === EVALUATION ? "Evaluation" : settings.mode === RANDOM ? "Random" : "Predictable"}`,
        `# Display Physical Width: ${round(calibration.screenWidthCm, 2)} cm`,
        `# Display Physical Height: ${round(calibration.screenHeightCm, 2)} cm`,
        `# Screen Resolution: ${screenPixels.width} x ${screenPixels.height} px`,
        `# Viewing Distance: ${round(calibration.viewingDistanceCm, 2)} cm`,
        `# Stimulus Type: ${(STIMULUS_TYPES[stimulusType] && STIMULUS_TYPES[stimulusType].name) || stimulusType}`,
        `# Stimulus Size: ${round(ballArcmin, 2)} arcmin (${(ballArcmin / 60).toFixed(2)} deg)`,
        `# Movement Speed: ${settings.speedArcminSec ? settings.speedArcminSec + " arcmin/s" : "N/A"}`,
        `# Hit Distance Threshold: ${thresholdDeg} deg (${thresholdArcmin} arcmin / approx. ${thresholdPx} px screen radius)`,
        `# GUI Distance Threshold: ${thresholdDetails.baseDeg} deg`,
        `# ${sourceTag} Assumed Measurement-Error Allowance: ${thresholdDetails.allowanceDeg} deg`,
        `# Validation Threshold (2x Mean Error): ${thresholdDetails.validationDeg ?? "N/A"} deg`,
        `# Total Test Duration: ${(actualDurationMs / 1000).toFixed(2)} s`,
        `# Valid Gaze Duration (Denominator): ${(totalValidMs / 1000).toFixed(2)} s`,
        `# Blink Duration (Excluded): ${(totalBlinkMs / 1000).toFixed(2)} s`,
        `# On-Target Duration (Numerator): ${(totalInThreshMs / 1000).toFixed(2)} s`,
        `# Gaze Accuracy Rate: ${accuracyRate}`,
        `# Accuracy Definition: On-target duration / valid gaze duration (not hardware calibration accuracy)`,
        `# Accuracy Scoring Phases: ${accuracyPhases}`,
        `# Accuracy Sample Weight: accuracy_delta_t_ms is the valid interval overlapping scoring phases; is_within_threshold reports raw spatial proximity even during excluded phases`,
        ...(tff ? [
          `# Mean Time To First Fixation (TFF): ${tff.mean_ms ?? "N/A"} ms`,
          `# TFF Detected Targets: ${tff.detected_targets} / ${tff.total_targets}`,
          `# TFF Definition: Target onset to first fixation onset AFTER detected eye movement; target hit not required; independent of the 200 ms accuracy grace window`,
          `# TFF Fixation Classifier: I-VT-style; velocity <= ${tff.velocity_threshold_deg_s} deg/s for >= ${tff.minimum_duration_ms} ms and >= 3 valid samples; gaps > ${tff.maximum_gap_ms} ms or invalid samples break fixation`,
          ...tff.targets.map(target => `# TFF Target ${target.target_number}: ${target.tff_ms ?? "N/A"} ms; direction=${target.direction}; status=${target.status}; target_onset_ms=${target.target_onset_ms}; fixation_onset_ms=${target.fixation_onset_ms ?? "N/A"}; fixation_confirmed_ms=${target.fixation_confirmed_ms ?? "N/A"}`)
        ] : []),
        `# Sample Timing Reference: ${eyeTrackingSource === EYE_SOURCE_WEBGAZER ? "WebGazer inference start on the browser performance clock (camera exposure timestamp unavailable); transport_delay_ms measures inference-start to callback delay, excluding camera capture and filtering delay" : eyeTrackingSource === EYE_SOURCE_TOBII ? "Tobii device timestamp mapped to the browser performance clock when synchronized" : "N/A (untracked)"}`,
        `# Clock Sync Estimated Uncertainty (half RTT): ${gazeCapture.clockUncertaintyMs != null ? round(gazeCapture.clockUncertaintyMs, 3) + " ms" : eyeTrackingSource === EYE_SOURCE_WEBGAZER ? "N/A (same browser performance clock; camera capture delay not measured)" : "N/A (browser receipt time)"}`,
        `# Excluded Missing-Sample Duration: ${((gazeCapture.missingDurationMs || 0) / 1000).toFixed(3)} s`,
        `# Rejected Duplicate/Out-of-Order Timestamps: ${gazeCapture.rejectedTimestampSamples || 0}`,
        `# Enabled Directions: ${selectedDirectionLabels.join(", ") || "All"}`,
        `# Completed Targets: ${completedTargets}`,
        `# Test Termination Reason: ${reason}`,
        `# Eye Tracker Hardware: ${deviceName}`,
        `# Sampling Frequency: ${samplingRateText}`,
        `# Total Gaze Samples: ${records.length}`,
        `# ------------------------------------------------------------`
      ];

      const tableHeaders = [
        "sample_index",
        "trial_time_ms",
        "device_timestamp_us",
        "delta_t_ms",
        "instant_hz",
        "gaze_valid",
        "gaze_x_px",
        "gaze_y_px",
        "stimulus_x_px",
        "stimulus_y_px",
        "distance_error_px",
        "distance_error_deg",
        "is_within_threshold",
        "phase",
        "direction",
        "browser_received_trial_time_ms",
        "transport_delay_ms",
        "stimulus_frame_time_ms",
        "clock_mapping",
        "target_number",
        "accuracy_eligible",
        "accuracy_delta_t_ms",
        "gaze_velocity_deg_s",
        "is_fixation",
        "tff_ms"
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
        csvEscape(DIRECTION_ENGLISH_LABELS[r.direction] || r.direction),
        r.browser_received_trial_time_ms,
        r.transport_delay_ms ?? "",
        r.stimulus_frame_time_ms,
        csvEscape(r.clock_mapping),
        r.target_number,
        r.accuracy_eligible,
        r.accuracy_delta_t_ms,
        r.gaze_velocity_deg_s ?? "",
        r.is_fixation ?? "",
        r.tff_ms ?? ""
      ].join(","));

      const fullCsvContent = [
        ...metaLines,
        tableHeaders.join(","),
        ...rowLines
      ].join("\r\n");

      if (window.OcuTrainDesktop) {
        AppState.lastCsvReport = { filename: csvFilename, content: fullCsvContent };
        return saveDesktopDocument(csvFilename, fullCsvContent);
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
        const usesWebGazer = eyeTracking.source === EYE_SOURCE_WEBGAZER;
        const usesGazeTracking = usesTobii || usesWebGazer;
        let activeTrialCapture = null;
        if (usesTobii) activeTrialCapture = beginTobiiTrial(sessionId);
        else if (usesWebGazer) activeTrialCapture = beginWebGazerTrial(sessionId);

        let unsubscribeWebgazer = null;
        if (usesWebGazer) {
          try { if (window.webgazer) window.webgazer.resume(); } catch (e) {}
          const extension = this.jsPsych.extensions && this.jsPsych.extensions.webgazer;
          if (extension) {
            if (!extension.__handleGazeDataUpdateWrapped) {
              const origHandle = extension.handleGazeDataUpdate;
              extension.handleGazeDataUpdate = function(e, i) {
                origHandle.call(extension, e, i);
                if (e === null && extension.gazeUpdateCallbacks) {
                  for (var a = 0; a < extension.gazeUpdateCallbacks.length; a++) {
                    try { extension.gazeUpdateCallbacks[a](null); } catch (err) {}
                  }
                }
              };
              extension.__handleGazeDataUpdateWrapped = true;
            }

            if (typeof extension.onGazeUpdate === "function") {
              unsubscribeWebgazer = extension.onGazeUpdate((prediction) => {
                if (ended || sessionStart === null || !activeTrialCapture || !activeTrialCapture.onSample) return;
                if (activeTrialCapture.samples.length >= MAX_GAZE_SAMPLES_PER_TRIAL) {
                  activeTrialCapture.overflow += 1;
                  return;
                }
                const receivedAt = performance.now();
                const sourceTime = prediction?.sample_performance_ms;
                const hasSourceTime = Number.isFinite(sourceTime) && sourceTime >= 0 && sourceTime <= receivedAt;
                const sampleTime = hasSourceTime ? sourceTime : receivedAt;
                const valid = Boolean(prediction && Number.isFinite(prediction.x) && Number.isFinite(prediction.y));
                const sample = {
                  valid,
                  x: valid ? prediction.x : null,
                  y: valid ? prediction.y : null,
                  device_timestamp_us: Math.round(sampleTime * 1000),
                  sample_performance_ms: sampleTime,
                  transport_delay_ms: hasSourceTime ? round(receivedAt - sampleTime, 3) : null,
                  clock_mapping: hasSourceTime ? "webgazer_inference_start_to_browser_performance" : "browser_receipt_time"
                };
                activeTrialCapture.samples.push(sample);
                activeTrialCapture.onSample(sample);
              });
            }
          }
        }
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

        const thresholdDetails = gazeThresholds(eyeTracking.source, settings);
        const thresholdDeg = thresholdDetails.effectiveDeg;
        const thresholdArcmin = round(thresholdDeg * 60, 2);
        const thresholdRadiusPx = physicalSizeForArcmin(thresholdArcmin, calibration.viewingDistanceCm) * screenPixels.width / calibration.screenWidthCm;

        if (activeTrialCapture) {
          activeTrialCapture.onSample = (sample) => {
            if (ended || sessionStart === null) return;
            const nowPerf = performance.now();
            const active = activeTrialCapture;
            if (!active) return;

            const sampleTime = sample.sample_performance_ms ?? nowPerf;
            const trialTime = sampleTime - sessionStart;
            if (trialTime < 0) return;
            const currentTsUs = sample.device_timestamp_us ?? Math.round(sampleTime * 1000);
            if (active.lastSampleTsUs !== null && currentTsUs <= active.lastSampleTsUs) {
              active.rejectedTimestampSamples = (active.rejectedTimestampSamples || 0) + 1;
              return;
            }
            const deltaMs = active.lastSampleTsUs === null ? 1000 / 33 : (currentTsUs - active.lastSampleTsUs) / 1000;
            active.lastSampleTsUs = currentTsUs;

            // Match the sample's source timestamp to the displayed frame before its callback arrived.
            let low = 0;
            let high = frameCoordinates.length - 1;
            let frame = null;
            let frameIndex = -1;
            while (low <= high) {
              const mid = Math.floor((low + high) / 2);
              if (frameCoordinates[mid].timestamp_ms <= trialTime) {
                frame = frameCoordinates[mid];
                frameIndex = mid;
                low = mid + 1;
              } else high = mid - 1;
            }
            if (!frame) return;
            const effectiveDeltaMs = Math.min(deltaMs > 100 ? 1000 / 33 : deltaMs, trialTime);
            if (deltaMs > 100) active.missingDurationMs = (active.missingDurationMs || 0) + deltaMs - effectiveDeltaMs;
            const isSaccadeLatency = moduleKey === "saccade" && frame.phase === "dwell" && trialTime - frame.phase_started_ms < 200;
            const eligibleStart = accuracyPhaseStart(moduleKey, frame);
            const accuracyEligible = eligibleStart !== null && trialTime >= eligibleStart;
            const scoredDeltaMs = accuracyEligible
              ? accuracyDurationMs(moduleKey, frameCoordinates, frameIndex, trialTime, effectiveDeltaMs) : 0;

            let isWithin = 0;
            let distPx = null;
            let distDeg = null;

            if (!sample.valid) {
              active.totalBlinkMs += effectiveDeltaMs;
            } else {
              const dx = sample.x - frame.stimulus_center_x;
              const dy = sample.y - frame.stimulus_center_y;
              distPx = Math.hypot(dx, dy);
              distDeg = gazeErrorDegrees(dx, dy, calibration, screenPixels);
              isWithin = distDeg <= thresholdDeg ? 1 : 0;

              active.totalValidMs += scoredDeltaMs;
              if (isWithin) active.totalInThreshMs += scoredDeltaMs;
            }

            active.synchronousRecords.push({
              sample_index: active.synchronousRecords.length + 1,
              trial_time_ms: round(trialTime, 2),
              browser_received_trial_time_ms: round(nowPerf - sessionStart, 2),
              transport_delay_ms: sample.transport_delay_ms ?? null,
              stimulus_frame_time_ms: frame.timestamp_ms,
              clock_mapping: sample.clock_mapping || "browser_performance_clock",
              device_timestamp_us: currentTsUs,
              delta_t_ms: round(deltaMs, 2),
              instant_hz: deltaMs > 0 ? round(1000 / deltaMs, 1) : 33.0,
              gaze_valid: sample.valid ? 1 : 0,
              gaze_x_px: sample.valid ? round(sample.x, 2) : "",
              gaze_y_px: sample.valid ? round(sample.y, 2) : "",
              stimulus_x_px: round(frame.stimulus_center_x, 2),
              stimulus_y_px: round(frame.stimulus_center_y, 2),
              distance_error_px: distPx !== null ? round(distPx, 2) : "",
              distance_error_deg: distDeg !== null ? round(distDeg, 3) : "",
              is_within_threshold: isWithin,
              accuracy_eligible: accuracyEligible ? 1 : 0,
              accuracy_delta_t_ms: sample.valid ? round(scoredDeltaMs, 3) : 0,
              phase: isSaccadeLatency ? "saccade_latency" : frame.phase,
              target_number: frame.target_number,
              direction: frame.direction
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
          if (unsubscribeWebgazer) {
            try { unsubscribeWebgazer(); } catch (e) {}
            unsubscribeWebgazer = null;
          }
          if (usesWebGazer && window.webgazer) {
            try { window.webgazer.pause(); } catch (e) {}
          }
          const gazeCapture = usesTobii
            ? finishTobiiTrial(sessionId)
            : usesWebGazer
              ? finishWebGazerTrial(sessionId)
              : { samples: [], downsampled: 0, overflow: 0, synchronousRecords: [], totalBlinkMs: 0, totalValidMs: 0, totalInThreshMs: 0, accuracyRate: null };
          if (usesTobii && injectedBridgeClient && injectedBridgeClient.connectionState === "ready") {
            void injectedBridgeClient.stop().catch((error) => {
              AppState.tobii.lastError = error && error.message ? error.message : "Could not stop the Tobii Bridge provider after the trial.";
            });
          }
          const normalFrameMedian = median(sampledFrameGaps.filter((gap) => gap > 4 && gap < 100));
          const tff = moduleKey === "saccade"
            ? saccadeFixationSummary(gazeCapture.synchronousRecords || [], events, calibration, screenPixels) : null;

          // Automatically export synchronous CSV record
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
            thresholdDeg,
            thresholdDetails,
            thresholdArcmin,
            thresholdPx: round(thresholdRadiusPx, 1),
            gazeCapture,
            tff
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
            accuracy_rate: gazeCapture.accuracyRate,
            ...(tff ? {
              tff_mean_ms: tff.mean_ms,
              tff_detected_targets: tff.detected_targets,
              tff_total_targets: tff.total_targets,
              tff_analysis: tff
            } : {}),
            in_threshold_sec: round((gazeCapture.totalInThreshMs || 0) / 1000, 2),
            valid_sec: round((gazeCapture.totalValidMs || 0) / 1000, 2),
            blink_sec: round((gazeCapture.totalBlinkMs || 0) / 1000, 2),
            threshold_deg: thresholdDeg,
            threshold_setting_deg: thresholdDetails.baseDeg,
            tracker_error_allowance_deg: thresholdDetails.allowanceDeg,
            validation_threshold_deg: thresholdDetails.validationDeg,
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
                : usesTobii ? (nativeBridge ? "Tauri 2 Tobii Bridge" : "Local Tobii WebSocket Bridge") : null,
              provider: usesTobii ? AppState.tobii.provider : (usesWebGazer ? "WebGazer" : null),
              provider_mode: usesTobii ? AppState.tobii.providerMode : (usesWebGazer ? "webcam" : null),
              sampling_interval_ms: eyeTracking.source === EYE_SOURCE_WEBGAZER ? 34 : usesTobii ? TOBII_SAMPLE_INTERVAL_MS : null,
              clock_sync_estimated_uncertainty_ms: usesTobii ? gazeCapture.clockUncertaintyMs ?? null : null,
              hardware_calibration_confirmed: usesTobii ? AppState.tobii.hardwareCalibrationConfirmed : null
            },
            gaze_path: JSON.stringify(gazeCapture.samples || []),
            gaze_sample_count: (gazeCapture.samples || []).length,
            gaze_downsampled_count: gazeCapture.downsampled || 0,
            gaze_overflow_count: gazeCapture.overflow || 0,
            gaze_rejected_timestamp_count: gazeCapture.rejectedTimestampSamples || 0,
            gaze_missing_duration_ms: gazeCapture.missingDurationMs || 0,
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
        let movementFrom = null;
        let movementTo = null;
        let movementDuration = 0;
        let returnReachedCenter = false;
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
          returnReachedCenter = false;
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
            phase = "return";
            phaseStart = now;
            movementFrom = { ...movementTo };
            movementTo = { ...center };
            phaseEnd = now + movementDuration;
            logEvent("return_onset", now, {
              target_number: completedTargets + 1,
              direction: currentDirection,
              duration_ms: round(movementDuration, 3)
            });
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
          if (phase === "return" && returnReachedCenter) {
            if (settings.mode === EVALUATION && completedTargets >= picker.evaluationTotal) endTrial("evaluation_complete");
            else beginExcursion(now);
            return;
          }
          if (phase === "movement" || phase === "return") {
            const ratio = movementDuration <= 0 ? 1 : Math.min(1, Math.max(0, (now - phaseStart) / movementDuration));
            setPosition({
              x: movementFrom.x + (movementTo.x - movementFrom.x) * ratio,
              y: movementFrom.y + (movementTo.y - movementFrom.y) * ratio
            });
            if (stimulusType === "numbers_dot") {
              updateDynamicNumber(now);
            }
            if (ratio >= 1) {
              if (phase === "movement") finishMovementAtEdge(now);
              else {
                completedTargets += 1;
                returnReachedCenter = true;
                logEvent("center_arrival", now, { target_number: completedTargets, direction: currentDirection });
              }
            }
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
              phase_started_ms: round(phaseStart - sessionStart, 3),
              target_number: phase === "return" && returnReachedCenter ? completedTargets : completedTargets + 1,
              direction: currentDirection || currentGridKey || "center",
              direction_label: DIRECTION_ENGLISH_LABELS[currentDirection || currentGridKey] || currentDirection || currentGridKey || "Center",
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
              if (data.ready && (AppState.pending?.calibrateOnly || pendingSessionGeometryIsValid())) {
                AppState.eyeTracking.initialized = true;
                AppState.eyeTracking.lastError = null;
              } else {
                if (AppState.pending && AppState.pending.calibrateOnly) {
                  AppState.pending = null;
                } else {
                  fallBackToUntrackedSession(data.error || "Fullscreen or viewport changed during camera setup.");
                }
              }
            }
          }],
          conditional_function: () => !AppState.eyeTracking.initialized
        },
        {
          timeline: [
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
                    (AppState.pending?.calibrateOnly || pendingSessionGeometryIsValid(calibrationStartViewport));
                  if (!geometryStayedValid) {
                    data.webgazer_calibration_error = "Fullscreen or viewport changed during calibration.";
                    if (AppState.pending && AppState.pending.calibrateOnly) {
                      AppState.pending = null;
                    } else {
                      fallBackToUntrackedSession(data.webgazer_calibration_error);
                    }
                    return;
                  }
                  AppState.eyeTracking.calibrated = true;
                  AppState.eyeTracking.needsRecalibration = false;
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
                (!AppState.eyeTracking.calibrated || AppState.eyeTracking.needsRecalibration)
              )
            },
            {
              timeline: [{
                type: GazeValidationPlugin,
                data: { action: "webgazer_validated" }
              }],
              conditional_function: () => Boolean(
                AppState.pending &&
                AppState.pending.eyeTrackingEnabled &&
                AppState.eyeTracking.initialized
              )
            }
          ],
          loop_function: () => Boolean(AppState.eyeTracking.needsRecalibration),
          conditional_function: () => Boolean(
            AppState.pending &&
            AppState.pending.eyeTrackingEnabled &&
            AppState.eyeTracking.initialized
          )
        }
      ],
      conditional_function: () => Boolean(
        AppState.pending &&
        AppState.pending.eyeTrackingEnabled &&
        AppState.pending.eyeTrackingSource === EYE_SOURCE_WEBGAZER
      )
    } : { timeline: [], conditional_function: () => false };

    function webgazerSessionIsReady() {
      if (!webgazerTrainingTrial || !AppState.pending || AppState.pending.eyeTrackingSource !== EYE_SOURCE_WEBGAZER) {
        return false;
      }
      if (AppState.pending.calibrateOnly) {
        AppState.pending = null;
        return false;
      }
      if (!AppState.eyeTracking.calibrated) {
        return false;
      }
      if (!viewportSignaturesMatch(AppState.eyeTracking.calibrationViewport, currentViewportSignature())) {
        fallBackToUntrackedSession("Fullscreen or viewport changed after eye-tracker calibration.");
        return false;
      }
      return true;
    }

    const tobiiSetupNode = {
      timeline: [
        {
          timeline: [{
            type: GazeValidationPlugin,
            data: { action: "tobii_validated" }
          }],
          conditional_function: () => Boolean(
            AppState.pending &&
            AppState.pending.eyeTrackingSource === EYE_SOURCE_TOBII &&
            AppState.tobii.connected &&
            AppState.tobii.hardwareCalibrationConfirmed &&
            (!AppState.tobii.validated || AppState.tobii.needsRevalidation)
          )
        }
      ],
      loop_function: () => Boolean(AppState.tobii.needsRevalidation),
      conditional_function: () => Boolean(
        AppState.pending &&
        AppState.pending.eyeTrackingSource === EYE_SOURCE_TOBII &&
        AppState.tobii.connected &&
        AppState.tobii.hardwareCalibrationConfirmed
      )
    };

    function tobiiSessionIsReady() {
      if (!AppState.pending || AppState.pending.eyeTrackingSource !== EYE_SOURCE_TOBII) return false;
      if (AppState.pending.calibrateOnly) {
        AppState.pending = null;
        return false;
      }
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
      if (!AppState.tobii.validated) {
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
        tobiiSetupNode,
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
