' Launches the Hugging Face Downloader desktop app.
'
' electron.exe is a GUI-subsystem binary, so running it directly never allocates
' a console window - that is why this launcher exists instead of going through
' cmd.exe -> npm.cmd, which used to leave a terminal open for the life of the app.
'
' The second argument to shell.Run is the show-window style, and it is NOT just
' advice for the launcher: Windows passes it to the child in STARTUPINFO, and
' Chromium applies it to the first window Electron opens. Passing 0 (SW_HIDE)
' therefore started the whole app with its window hidden - four electron.exe
' processes running, nothing on screen, no error anywhere. It must stay 1
' (SW_SHOWNORMAL). Nothing here needs hiding: wscript.exe and electron.exe are
' both GUI binaries, so neither flashes a console.
Option Explicit

Const SW_SHOWNORMAL = 1

Dim shell, fso, root, electron
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electron) Then
  MsgBox "Desktop dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Open a terminal in:" & vbCrLf & root & vbCrLf & vbCrLf & _
         "and run 'npm install' once, then launch this again.", _
         vbExclamation, "Hugging Face Downloader"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
shell.Run """" & electron & """ .", SW_SHOWNORMAL, False
