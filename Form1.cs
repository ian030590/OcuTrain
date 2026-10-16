using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

namespace TobiiEyeTrainer
{
    public partial class Form1 : Form
    {
        private WebView2? _webView;
        private TobiiDevice? _device;
        private TobiiBridge? _bridge;

        public Form1()
        {
            InitializeComponent();
            this.AutoScaleMode = AutoScaleMode.Dpi;
            this.Text = "Oculomotor Training System - Tobii Eye Tracker 5 (33 Hz)";
            this.WindowState = FormWindowState.Maximized;
            this.BackColor = Color.FromArgb(11, 11, 11);

            InitializeWebViewAsync();
        }

        private async void InitializeWebViewAsync()
        {
            try
            {
                _device = new TobiiDevice();
                _device.Start(allowSimulatorFallback: false);

                _webView = new WebView2
                {
                    Dock = DockStyle.Fill
                };
                this.Controls.Add(_webView);

                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "TobiiEyeTrainerWebView"
                );
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await _webView.EnsureCoreWebView2Async(env);

                _bridge = new TobiiBridge(_device, _webView);
                _webView.CoreWebView2.AddHostObjectToScript("TobiiBridge", _bridge);

                _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
                _webView.CoreWebView2.Settings.IsPinchZoomEnabled = false;
                _webView.ZoomFactor = 1.0;

                var previousBounds = Bounds;
                var previousWindowState = WindowState;
                var previousBorderStyle = FormBorderStyle;
                _webView.CoreWebView2.ContainsFullScreenElementChanged += (_, _) =>
                {
                    if (_webView.CoreWebView2.ContainsFullScreenElement)
                    {
                        // Capture the display before restoring a maximized window changes its location.
                        var fullscreenBounds = Screen.FromControl(this).Bounds;
                        previousBounds = Bounds;
                        previousWindowState = WindowState;
                        previousBorderStyle = FormBorderStyle;
                        WindowState = FormWindowState.Normal;
                        FormBorderStyle = FormBorderStyle.None;
                        Bounds = fullscreenBounds;
                    }
                    else
                    {
                        FormBorderStyle = previousBorderStyle;
                        Bounds = previousBounds;
                        WindowState = previousWindowState;
                    }
                };

                // Grant camera permissions automatically for WebGazer
                _webView.CoreWebView2.PermissionRequested += (s, args) =>
                {
                    if (args.PermissionKind == CoreWebView2PermissionKind.Camera)
                    {
                        args.State = CoreWebView2PermissionState.Allow;
                    }
                };

                // Inject bridge listener script before document loads
                await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
                    window.isTobiiNativeHost = true;
                    if (window.chrome && window.chrome.webview) {
                        window.chrome.webview.addEventListener('message', function(event) {
                            if (event.data && typeof event.data === 'object') {
                                if (typeof window.handleNativeTobiiMessage === 'function') {
                                    window.handleNativeTobiiMessage(event.data);
                                }
                            }
                        });
                    }
                ");

                string wwwrootDir = Path.Combine(Program.AppDirectory, "wwwroot");
                if (!Directory.Exists(wwwrootDir))
                {
                    wwwrootDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");
                }
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "appassets",
                    wwwrootDir,
                    CoreWebView2HostResourceAccessKind.Allow
                );

                _webView.CoreWebView2.Navigate("https://appassets/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show($"WebView2 initialization failed: {ex.Message}\nPlease ensure Microsoft Edge WebView2 Runtime is installed.", "Startup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _device?.Dispose();
            base.OnFormClosing(e);
        }
    }
}
