using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;

namespace TobiiEyeTrainer
{
    [ClassInterface(ClassInterfaceType.AutoDual)]
    [ComVisible(true)]
    public class TobiiBridge
    {
        private readonly TobiiDevice _device;
        private readonly WebView2 _webView;
        private readonly string _dataDir;

        public bool IsConnected => _device.IsConnected;
        public bool IsSimulated => _device.IsSimulator;
        public string DeviceName => _device.DeviceName;
        public int SamplingRateHz => 33;

        public TobiiBridge(TobiiDevice device, WebView2 webView)
        {
            _device = device;
            _webView = webView;

            // Create Data directory next to executable
            string baseDir = Program.AppDirectory;
            _dataDir = Path.Combine(baseDir, "Data");
            if (!Directory.Exists(_dataDir))
            {
                Directory.CreateDirectory(_dataDir);
            }

            _device.GazeReceived += OnGazeReceived;
            _device.StatusChanged += (_, _) => PostMessage(GetStatusJson);
        }

        private void OnGazeReceived(object? sender, GazeSampleEventArgs e)
        {
            PostMessage(() =>
            {
                // shortcut: tracking uses the primary display; add explicit display selection for multi-monitor setups.
                var screen = Screen.PrimaryScreen?.Bounds ?? Screen.FromControl(_webView).Bounds;
                var origin = _webView.PointToScreen(System.Drawing.Point.Empty);
                return JsonSerializer.Serialize(new
                {
                    type = "gaze",
                    x = float.IsFinite(e.X) ? (float?)e.X : null,
                    y = float.IsFinite(e.Y) ? (float?)e.Y : null,
                    deviceTimestampMicroseconds = e.TimestampUs,
                    valid = e.Valid && float.IsFinite(e.X) && float.IsFinite(e.Y),
                    isSimulated = e.IsSimulated,
                    coordinateSpace = "screen_normalized",
                    sourceWidth = screen.Width,
                    sourceHeight = screen.Height,
                    viewportOffsetX = origin.X - screen.Left,
                    viewportOffsetY = origin.Y - screen.Top,
                    viewportWidth = _webView.ClientSize.Width,
                    viewportHeight = _webView.ClientSize.Height,
                    samplingRateHz = 33
                });
            });
        }

        private void PostMessage(Func<string> createJson)
        {
            if (_webView.IsDisposed || !_webView.IsHandleCreated) return;
            try
            {
                _webView.BeginInvoke(new Action(() =>
                {
                    if (!_webView.IsDisposed && _webView.CoreWebView2 != null)
                    {
                        _webView.CoreWebView2.PostWebMessageAsJson(createJson());
                    }
                }));
            }
            catch { }
        }

        public string GetStatusJson()
        {
            var status = new
            {
                type = "status",
                connected = _device.IsConnected,
                simulated = _device.IsSimulator,
                deviceName = _device.DeviceName,
                coordinateSpace = "screen_normalized",
                lastError = _device.LastError,
                samplingRateHz = 33
            };
            return JsonSerializer.Serialize(status);
        }

        public string GetClockJson()
        {
            return JsonSerializer.Serialize(new { systemTimestampMicroseconds = _device.GetSystemTimestampUs() });
        }

        public string SaveCsv(string filename, string csvContent)
        {
            try
            {
                // Ensure safe filename
                string safeName = string.Join("_", filename.Split(Path.GetInvalidFileNameChars()));
                string filePath = Path.Combine(_dataDir, safeName);
                
                // Write with UTF-8 BOM so Excel opens traditional Chinese correctly
                File.WriteAllText(filePath, csvContent, System.Text.Encoding.UTF8);
                return filePath;
            }
            catch (Exception ex)
            {
                return $"Error: {ex.Message}";
            }
        }

        public void OpenDataFolder()
        {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = _dataDir,
                    UseShellExecute = true,
                    Verb = "open"
                });
            }
            catch { }
        }
    }
}
