using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace TobiiEyeTrainer
{
    public class GazeSampleEventArgs : EventArgs
    {
        public float X { get; set; }
        public float Y { get; set; }
        public long TimestampUs { get; set; }
        public bool Valid { get; set; }
        public bool IsSimulated { get; set; }
    }

    public class TobiiDevice : IDisposable
    {
        public event EventHandler<GazeSampleEventArgs>? GazeReceived;
        public event EventHandler<string>? StatusChanged;

        private IntPtr _api = IntPtr.Zero;
        private IntPtr _device = IntPtr.Zero;
        private Thread? _workerThread;
        private volatile bool _running = false;
        private TobiiInterop.tobii_gaze_point_callback_t? _gazeCallback;
        private bool _isSimulator = false;

        public bool IsConnected => _running && (_device != IntPtr.Zero || _isSimulator);
        public bool IsSimulator => _isSimulator;
        public string DeviceName => _isSimulator ? "Tobii Eye Tracker 5 (Simulator)" : "Tobii Eye Tracker 5";
        public string? LastError { get; private set; }

        public TobiiDevice()
        {
        }

        public bool Start(bool allowSimulatorFallback = true)
        {
            if (_running) return true;
            if (_api != IntPtr.Zero || _isSimulator) Stop();
            LastError = null;

            try
            {
                var err = TobiiInterop.tobii_api_create(out _api, IntPtr.Zero, IntPtr.Zero);
                if (err != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR || _api == IntPtr.Zero)
                {
                    throw new InvalidOperationException($"Tobii API initialization failed: {err}");
                }

                var urls = new List<string>();
                TobiiInterop.tobii_device_url_receiver_t receiver = (IntPtr urlPtr, IntPtr userData) =>
                {
                    string? url = Marshal.PtrToStringAnsi(urlPtr);
                    if (!string.IsNullOrEmpty(url)) urls.Add(url);
                };

                var enumErr = TobiiInterop.tobii_enumerate_local_device_urls(_api, receiver, IntPtr.Zero);
                if (enumErr != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                    throw new InvalidOperationException($"Tobii device enumeration failed: {enumErr}");

                if (urls.Count > 0)
                {
                    string deviceUrl = urls[0];
                    var devErr = TobiiInterop.tobii_device_create(_api, deviceUrl, TobiiInterop.tobii_field_of_use_t.TOBII_FIELD_OF_USE_INTERACTIVE, out _device);
                    if (devErr == TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR && _device != IntPtr.Zero)
                    {
                        _isSimulator = false;
                        var syncErr = TobiiInterop.tobii_update_timesync(_device);
                        if (syncErr != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                            throw new InvalidOperationException($"Tobii clock synchronization failed: {syncErr}");
                        _gazeCallback = OnGazePointReceived;
                        var subErr = TobiiInterop.tobii_gaze_point_subscribe(_device, _gazeCallback, IntPtr.Zero);
                        if (subErr != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                            throw new InvalidOperationException($"Tobii gaze subscription failed: {subErr}");

                        _running = true;
                        _workerThread = new Thread(WorkerLoop)
                        {
                            IsBackground = true,
                            Name = "TobiiNativeGazeThread",
                            Priority = ThreadPriority.AboveNormal
                        };
                        _workerThread.Start();

                        StatusChanged?.Invoke(this, $"Connected to {DeviceName} ({deviceUrl})");
                        return true;
                    }
                    throw new InvalidOperationException($"Tobii device connection failed: {devErr}");
                }

                throw new InvalidOperationException("No Tobii Eye Tracker 5 device detected.");
            }
            catch (Exception ex)
            {
                Stop();
                LastError = ex.Message;
                if (allowSimulatorFallback)
                {
                    StartSimulator($"Exception loading Tobii driver ({ex.Message}), falling back to simulator.");
                    return true;
                }
                StatusChanged?.Invoke(this, $"Error starting Tobii device: {LastError}");
                return false;
            }
        }

        private void StartSimulator(string reason)
        {
            _isSimulator = true;
            _running = true;
            _workerThread = new Thread(SimulatorLoop)
            {
                IsBackground = true,
                Name = "TobiiSimulatorThread"
            };
            _workerThread.Start();
            StatusChanged?.Invoke(this, $"Simulator active: {reason}");
        }

        private void WorkerLoop()
        {
            var deviceList = new[] { _device };
            var syncTimer = System.Diagnostics.Stopwatch.StartNew();
            while (_running && _device != IntPtr.Zero)
            {
                if (syncTimer.Elapsed.TotalSeconds >= 30)
                {
                    var syncErr = TobiiInterop.tobii_update_timesync(_device);
                    if (syncErr != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                    {
                        LastError = $"Tobii clock synchronization failed: {syncErr}";
                        _running = false;
                        StatusChanged?.Invoke(this, LastError);
                        break;
                    }
                    syncTimer.Restart();
                }
                var waitErr = TobiiInterop.tobii_wait_for_callbacks(1, deviceList);
                if (waitErr == TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                {
                    waitErr = TobiiInterop.tobii_device_process_callbacks(_device);
                }
                if (waitErr == TobiiInterop.tobii_error_t.TOBII_ERROR_TIMED_OUT)
                {
                    continue;
                }
                if (waitErr != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                {
                    LastError = $"Tobii gaze stream stopped: {waitErr}";
                    _running = false;
                    StatusChanged?.Invoke(this, LastError);
                    break;
                }
            }
        }

        private void OnGazePointReceived(ref TobiiInterop.tobii_gaze_point_t gazePoint, IntPtr userData)
        {
            if (!_running) return;

            bool isValid = gazePoint.validity == TobiiInterop.tobii_validity_t.TOBII_VALIDITY_VALID;
            GazeReceived?.Invoke(this, new GazeSampleEventArgs
            {
                X = gazePoint.position_x,
                Y = gazePoint.position_y,
                TimestampUs = gazePoint.timestamp_us,
                Valid = isValid,
                IsSimulated = false
            });
        }

        public long GetSystemTimestampUs()
        {
            if (_api == IntPtr.Zero) throw new InvalidOperationException("Tobii clock is unavailable.");
            var err = TobiiInterop.tobii_system_clock(_api, out long timestampUs);
            if (err != TobiiInterop.tobii_error_t.TOBII_ERROR_NO_ERROR)
                throw new InvalidOperationException($"Tobii system clock failed: {err}");
            return timestampUs;
        }

        private void SimulatorLoop()
        {
            // 33 Hz ~ 30.303 ms interval
            var random = new Random();
            long baseTimeUs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000;
            var sw = System.Diagnostics.Stopwatch.StartNew();

            float simX = 0.5f;
            float simY = 0.5f;

            while (_running)
            {
                long elapsedUs = sw.ElapsedTicks * 1000000L / System.Diagnostics.Stopwatch.Frequency;
                long sampleTimestampUs = baseTimeUs + elapsedUs;

                // Simulate slight jitter around center or cursor position
                var cursor = Cursor.Position;
                var bounds = Screen.PrimaryScreen?.Bounds ?? new System.Drawing.Rectangle(0, 0, 1920, 1080);
                float targetX = (float)cursor.X / bounds.Width;
                float targetY = (float)cursor.Y / bounds.Height;

                // Smoothly pull toward target
                simX += (targetX - simX) * 0.15f + (float)(random.NextDouble() - 0.5) * 0.005f;
                simY += (targetY - simY) * 0.15f + (float)(random.NextDouble() - 0.5) * 0.005f;

                // Simulate occasional blink (e.g. 1% chance)
                bool valid = random.NextDouble() > 0.015;

                GazeReceived?.Invoke(this, new GazeSampleEventArgs
                {
                    X = Math.Clamp(simX, 0f, 1f),
                    Y = Math.Clamp(simY, 0f, 1f),
                    TimestampUs = sampleTimestampUs,
                    Valid = valid,
                    IsSimulated = true
                });

                // Target 33Hz = ~30.3ms
                Thread.Sleep(30);
            }
        }

        public void Stop()
        {
            _running = false;
            // Join before destroying the native handles used by the callback thread.
            _workerThread?.Join();
            _workerThread = null;
            _isSimulator = false;
            try
            {
                if (_device != IntPtr.Zero)
                {
                    TobiiInterop.tobii_gaze_point_unsubscribe(_device);
                    TobiiInterop.tobii_device_destroy(_device);
                    _device = IntPtr.Zero;
                }
                if (_api != IntPtr.Zero)
                {
                    TobiiInterop.tobii_api_destroy(_api);
                    _api = IntPtr.Zero;
                }
            }
            catch { }

            StatusChanged?.Invoke(this, "Tobii Eye Tracker disconnected.");
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
