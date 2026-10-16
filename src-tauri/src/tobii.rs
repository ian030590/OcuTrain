use libloading::Library;
use serde::Serialize;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    fs,
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

type Handle = *mut c_void;
type UrlCallback = unsafe extern "C" fn(*const c_char, Handle);
type GazeCallback = unsafe extern "C" fn(*const NativeGaze, Handle);

#[repr(C)]
struct NativeGaze {
    timestamp_us: i64,
    validity: i32,
    x: f32,
    y: f32,
}

// The library stays loaded until all callbacks and native handles have been released.
struct Sdk {
    api_create: unsafe extern "C" fn(*mut Handle, Handle, Handle) -> i32,
    api_destroy: unsafe extern "C" fn(Handle) -> i32,
    enumerate: unsafe extern "C" fn(Handle, UrlCallback, Handle) -> i32,
    device_create: unsafe extern "C" fn(Handle, *const c_char, i32, *mut Handle) -> i32,
    device_destroy: unsafe extern "C" fn(Handle) -> i32,
    subscribe: unsafe extern "C" fn(Handle, GazeCallback, Handle) -> i32,
    unsubscribe: unsafe extern "C" fn(Handle) -> i32,
    wait: unsafe extern "C" fn(i32, *const Handle) -> i32,
    process: unsafe extern "C" fn(Handle) -> i32,
    clock: unsafe extern "C" fn(Handle, *mut i64) -> i32,
    timesync: unsafe extern "C" fn(Handle) -> i32,
    _library: Library,
}

impl Sdk {
    unsafe fn load(path: PathBuf) -> Result<Self, String> {
        let library = Library::new(path).map_err(|e| e.to_string())?;
        macro_rules! symbol {
            ($name:literal) => {
                *library
                    .get(concat!($name, "\0").as_bytes())
                    .map_err(|e| e.to_string())?
            };
        }
        Ok(Self {
            api_create: symbol!("tobii_api_create"),
            api_destroy: symbol!("tobii_api_destroy"),
            enumerate: symbol!("tobii_enumerate_local_device_urls"),
            device_create: symbol!("tobii_device_create"),
            device_destroy: symbol!("tobii_device_destroy"),
            subscribe: symbol!("tobii_gaze_point_subscribe"),
            unsubscribe: symbol!("tobii_gaze_point_unsubscribe"),
            wait: symbol!("tobii_wait_for_callbacks"),
            process: symbol!("tobii_device_process_callbacks"),
            clock: symbol!("tobii_system_clock"),
            timesync: symbol!("tobii_update_timesync"),
            _library: library,
        })
    }
}

struct Connection<'a> {
    sdk: &'a Sdk,
    api: Handle,
    device: Handle,
    subscribed: bool,
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        // Only the worker uses these handles, including system_clock and cleanup.
        unsafe {
            if self.subscribed {
                (self.sdk.unsubscribe)(self.device);
            }
            if !self.device.is_null() {
                (self.sdk.device_destroy)(self.device);
            }
            if !self.api.is_null() {
                (self.sdk.api_destroy)(self.api);
            }
        }
    }
}

fn check(code: i32, operation: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("Tobii {operation} failed (SDK error {code})"))
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    source_width: u32,
    source_height: u32,
    viewport_offset_x: i32,
    viewport_offset_y: i32,
    viewport_width: u32,
    viewport_height: u32,
}

impl Geometry {
    fn from_physical(monitor: (i32, i32, u32, u32), viewport: (i32, i32, u32, u32)) -> Self {
        Self {
            source_width: monitor.2,
            source_height: monitor.3,
            viewport_offset_x: viewport.0 - monitor.0,
            viewport_offset_y: viewport.1 - monitor.1,
            viewport_width: viewport.2,
            viewport_height: viewport.3,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    r#type: &'static str,
    pub connected: bool,
    simulated: bool,
    device_name: &'static str,
    coordinate_space: &'static str,
    provider_mode: &'static str,
    last_error: Option<String>,
}

impl Status {
    fn new(connected: bool, last_error: Option<String>) -> Self {
        Self {
            r#type: "status",
            connected,
            simulated: false,
            device_name: "Tobii Eye Tracker 5",
            coordinate_space: "screen_normalized",
            provider_mode: "tauri",
            last_error,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Gaze {
    r#type: &'static str,
    x: Option<f32>,
    y: Option<f32>,
    device_timestamp_microseconds: i64,
    valid: bool,
    is_simulated: bool,
    coordinate_space: &'static str,
    #[serde(flatten)]
    geometry: Geometry,
}

struct CallbackContext {
    app: AppHandle,
    geometry: Arc<Mutex<Geometry>>,
}

unsafe extern "C" fn collect_url(url: *const c_char, context: Handle) {
    if !url.is_null() {
        let urls = &mut *(context as *mut Vec<CString>);
        urls.push(CStr::from_ptr(url).to_owned());
    }
}

unsafe extern "C" fn receive_gaze(sample: *const NativeGaze, context: Handle) {
    let (Some(sample), Some(context)) = (
        sample.as_ref(),
        (context as *const CallbackContext).as_ref(),
    ) else {
        return;
    };
    let Ok(geometry) = context.geometry.lock() else {
        return;
    };
    let finite = sample.x.is_finite() && sample.y.is_finite();
    let payload = Gaze {
        r#type: "gaze",
        x: sample.x.is_finite().then_some(sample.x),
        y: sample.y.is_finite().then_some(sample.y),
        device_timestamp_microseconds: sample.timestamp_us,
        valid: sample.validity == 1 && finite,
        is_simulated: false,
        coordinate_space: "screen_normalized",
        geometry: geometry.clone(),
    };
    drop(geometry);
    let _ = context.app.emit_to("main", "tobii-gaze", payload);
}

type ClockRequest = mpsc::SyncSender<Result<i64, String>>;

pub struct Tracker {
    pub status: Arc<Mutex<Status>>,
    geometry: Arc<Mutex<Geometry>>,
    running: Arc<AtomicBool>,
    clock_requests: mpsc::Sender<ClockRequest>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Tracker {
    pub fn start(app: AppHandle) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel();
        let tracker = Arc::new(Self {
            status: Arc::new(Mutex::new(Status::new(
                false,
                Some("Connecting to Tobii…".into()),
            ))),
            geometry: Arc::new(Mutex::new(Geometry::default())),
            running: Arc::new(AtomicBool::new(true)),
            clock_requests: sender,
            worker: Mutex::new(None),
        });
        if let Some(window) = app.get_webview_window("main") {
            tracker.refresh_geometry(&window);
        }
        let status = Arc::clone(&tracker.status);
        let geometry = Arc::clone(&tracker.geometry);
        let running = Arc::clone(&tracker.running);
        let worker = thread::spawn(move || {
            let set_status = |connected, error| {
                let value = Status::new(connected, error);
                if let Ok(mut current) = status.lock() {
                    *current = value.clone();
                }
                let _ = app.emit_to("main", "tobii-status", value);
            };
            let result = run_stream(&app, geometry, &running, receiver, &set_status);
            set_status(false, result.err());
        });
        *tracker.worker.lock().unwrap() = Some(worker);
        tracker
    }

    pub fn refresh_geometry(&self, window: &WebviewWindow) {
        let geometry = (|| {
            // Tobii must be calibrated on this display in Tobii Experience before testing.
            let monitor = window.current_monitor().ok()??;
            let position = window.inner_position().ok()?;
            let size = window.inner_size().ok()?;
            Some(Geometry::from_physical(
                (
                    monitor.position().x,
                    monitor.position().y,
                    monitor.size().width,
                    monitor.size().height,
                ),
                (position.x, position.y, size.width, size.height),
            ))
        })()
        .unwrap_or_default();
        if let Ok(mut current) = self.geometry.lock() {
            *current = geometry;
        }
    }

    pub fn clock(&self) -> Result<i64, String> {
        if !self.status.lock().map_err(|e| e.to_string())?.connected {
            return Err("Tobii is not connected".into());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        self.clock_requests
            .send(sender)
            .map_err(|_| "Tobii worker stopped".to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|e| format!("Tobii clock unavailable: {e}"))?
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn run_stream(
    app: &AppHandle,
    geometry: Arc<Mutex<Geometry>>,
    running: &AtomicBool,
    requests: mpsc::Receiver<ClockRequest>,
    set_status: &impl Fn(bool, Option<String>),
) -> Result<(), String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("native");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("tobii_stream_engine.dll");
    let bytes = include_bytes!("../../tobii_stream_engine.dll");
    if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    let sdk = unsafe { Sdk::load(path)? };
    let mut callback = Box::new(CallbackContext {
        app: app.clone(),
        geometry,
    });
    let mut connection = Connection {
        sdk: &sdk,
        api: ptr::null_mut(),
        device: ptr::null_mut(),
        subscribed: false,
    };
    unsafe {
        check(
            (sdk.api_create)(&mut connection.api, ptr::null_mut(), ptr::null_mut()),
            "API initialization",
        )?;
        if connection.api.is_null() {
            return Err("Tobii API returned no handle".into());
        }
        let mut urls: Vec<CString> = Vec::new();
        check(
            (sdk.enumerate)(connection.api, collect_url, &mut urls as *mut _ as Handle),
            "device enumeration",
        )?;
        let url = urls
            .first()
            .ok_or("No Tobii Eye Tracker 5 device detected")?;
        check(
            (sdk.device_create)(connection.api, url.as_ptr(), 1, &mut connection.device),
            "device connection",
        )?;
        if connection.device.is_null() {
            return Err("Tobii device returned no handle".into());
        }
        check((sdk.timesync)(connection.device), "clock synchronization")?;
        check(
            (sdk.subscribe)(
                connection.device,
                receive_gaze,
                callback.as_mut() as *mut _ as Handle,
            ),
            "gaze subscription",
        )?;
        connection.subscribed = true;
        set_status(true, None);
        let mut last_sync = Instant::now();
        while running.load(Ordering::Acquire) {
            for response in requests.try_iter() {
                let mut timestamp = 0;
                let result = check((sdk.clock)(connection.api, &mut timestamp), "system clock")
                    .map(|_| timestamp);
                let _ = response.send(result);
            }
            if last_sync.elapsed() >= Duration::from_secs(30) {
                check((sdk.timesync)(connection.device), "clock synchronization")?;
                last_sync = Instant::now();
            }
            let code = (sdk.wait)(1, &connection.device);
            if code == 6 {
                continue;
            }
            check(code, "callback wait")?;
            // Deliver every native sample; no timer resampling or assumed device frequency.
            check((sdk.process)(connection.device), "callback processing")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_gaze_matches_the_sdk_abi() {
        assert_eq!(std::mem::size_of::<NativeGaze>(), 24);
        assert_eq!(std::mem::align_of::<NativeGaze>(), 8);
        assert_eq!(std::mem::offset_of!(NativeGaze, timestamp_us), 0);
        assert_eq!(std::mem::offset_of!(NativeGaze, validity), 8);
        assert_eq!(std::mem::offset_of!(NativeGaze, x), 12);
        assert_eq!(std::mem::offset_of!(NativeGaze, y), 16);
    }
    #[test]
    fn geometry_uses_physical_pixels_and_negative_monitor_origins() {
        let geometry =
            Geometry::from_physical((-2560, -100, 2560, 1440), (-2560, -100, 2560, 1440));
        assert_eq!(
            (geometry.viewport_offset_x, geometry.viewport_offset_y),
            (0, 0)
        );
        let geometry = Geometry::from_physical((0, 0, 2880, 1920), (225, 300, 2250, 1350));
        assert_eq!(
            (
                geometry.source_width,
                geometry.viewport_width,
                geometry.viewport_offset_x
            ),
            (2880, 2250, 225)
        );
    }
}
