' Friday - Hidden launcher (no console window)
' Used by the Start Menu shortcut to run `npm start` silently.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c npm start", 0, False
