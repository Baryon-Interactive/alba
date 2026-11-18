using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Alba.Release
{
    public static class AlbaReleaseBuild
    {
        public static void Build()
        {
            try
            {
                string targetName = Argument("-albaTarget");
                BuildTarget target = targetName switch
                {
                    "windows-x64" => BuildTarget.StandaloneWindows64,
                    "linux-x64" => BuildTarget.StandaloneLinux64,
                    "macos-arm64" or "macos-x64" => BuildTarget.StandaloneOSX,
                    "web-wasm32" => BuildTarget.WebGL,
                    _ => throw new ArgumentException("Unknown Alba build target: " + targetName)
                };
                var group = NamedBuildTarget.FromBuildTargetGroup(BuildPipeline.GetBuildTargetGroup(target));
                if (target != BuildTarget.WebGL)
                {
                    var backend = Argument("-albaBackend") switch
                    {
                        "il2cpp" => ScriptingImplementation.IL2CPP,
                        "mono" => ScriptingImplementation.Mono2x,
                        _ => throw new ArgumentException("Unknown Alba scripting backend.")
                    };
                    PlayerSettings.SetScriptingBackend(group, backend);
                }
                PlayerSettings.SetManagedStrippingLevel(group,
                    (ManagedStrippingLevel)Enum.Parse(typeof(ManagedStrippingLevel), Argument("-albaStripping"), true));
                if (target == BuildTarget.StandaloneOSX)
                {
                    // Use the same per-platform setting as the Unity 6 Build Profiles window.
                    EditorUserBuildSettings.SetPlatformSettings(BuildPipeline.GetBuildTargetName(target),
                        "Architecture", targetName == "macos-arm64" ? "arm64" : "x64");
                }

                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).Select(scene => scene.path).ToArray(),
                    locationPathName = Argument("-albaOutput"),
                    target = target,
                    options = BuildOptions.None
                });
                if (report.summary.result != BuildResult.Succeeded)
                    throw new InvalidOperationException("Alba player build ended with " + report.summary.result + ".");
            }
            catch (Exception error)
            {
                Debug.LogException(error);
                EditorApplication.Exit(1);
            }
        }

        private static string Argument(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.IndexOf(args, name);
            if (index < 0 || index + 1 >= args.Length)
                throw new ArgumentException("Missing Alba build argument: " + name);
            return args[index + 1];
        }
    }
}
