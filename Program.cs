using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TobiiEyeTrainer
{
    internal static class Program
    {
        public static string AppDirectory => Path.GetDirectoryName(Environment.ProcessPath) ?? AppDomain.CurrentDomain.BaseDirectory;

        [STAThread]
        static void Main()
        {
            SetupDllResolver();

            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try { File.WriteAllText(Path.Combine(AppDirectory, "crash.log"), e.ExceptionObject?.ToString()); } catch { }
            };

            Application.ThreadException += (s, e) =>
            {
                try { File.WriteAllText(Path.Combine(AppDirectory, "crash_thread.log"), e.Exception.ToString()); } catch { }
            };

            EnsureResourcesExtracted();

            ApplicationConfiguration.Initialize();
            Application.Run(new Form1());
        }

        private static void SetupDllResolver()
        {
            try
            {
                NativeLibrary.SetDllImportResolver(typeof(TobiiInterop).Assembly, (libraryName, assembly, searchPath) =>
                {
                    if (libraryName.Equals("tobii_stream_engine.dll", StringComparison.OrdinalIgnoreCase) ||
                        libraryName.Equals("tobii_stream_engine", StringComparison.OrdinalIgnoreCase))
                    {
                        string pathInAppDir = Path.Combine(AppDirectory, "tobii_stream_engine.dll");
                        if (File.Exists(pathInAppDir))
                        {
                            if (NativeLibrary.TryLoad(pathInAppDir, out IntPtr handle)) return handle;
                        }

                        string pathInBaseDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tobii_stream_engine.dll");
                        if (File.Exists(pathInBaseDir))
                        {
                            if (NativeLibrary.TryLoad(pathInBaseDir, out IntPtr handle)) return handle;
                        }
                    }
                    return IntPtr.Zero;
                });
            }
            catch { }
        }

        public static void EnsureResourcesExtracted()
        {
            try
            {
                string baseDir = AppDirectory;
                string wwwrootDir = Path.Combine(baseDir, "wwwroot");
                string dllPath = Path.Combine(baseDir, "tobii_stream_engine.dll");

                var assembly = Assembly.GetExecutingAssembly();
                string[] resourceNames = assembly.GetManifestResourceNames();

                if (!File.Exists(dllPath))
                {
                    using var stream = assembly.GetManifestResourceStream("TobiiEyeTrainer.tobii_stream_engine.dll");
                    if (stream != null)
                    {
                        using var file = File.Create(dllPath);
                        stream.CopyTo(file);
                    }
                }

                if (!Directory.Exists(wwwrootDir))
                {
                    Directory.CreateDirectory(wwwrootDir);
                }

                foreach (string res in resourceNames)
                {
                    if (res.StartsWith("TobiiEyeTrainer.wwwroot."))
                    {
                        string filename = res.Substring("TobiiEyeTrainer.wwwroot.".Length);
                        string targetFile = Path.Combine(wwwrootDir, filename);
                        using var stream = assembly.GetManifestResourceStream(res);
                        if (stream != null)
                        {
                            using var file = File.Create(targetFile);
                            stream.CopyTo(file);
                        }
                    }
                }
            }
            catch { }
        }
    }
}