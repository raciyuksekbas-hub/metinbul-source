; MetinBul's additions to electron-builder's NSIS uninstaller.
; Saved as UTF-8 with a byte-order mark: without one NSIS reads it in the
; build machine's ANSI code page and the Turkish text is garbled.
;
; Nothing here runs when the uninstaller is started by an update (--updated):
; an update keeps everything as it is.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6

    ; "Bilgisayar açıldığında MetinBul'u başlat": Electron writes
    ; "<this MetinBul.exe>" --metinbul-autostart under HKCU\...\Run, named
    ; after the app's AppUserModelID. Every Run value that starts this
    ; MetinBul goes, whatever its name, and its Task Manager on/off record
    ; with it. Until 0.4.4 it stayed behind and Windows tried to start a
    ; MetinBul that was no longer there at every sign-in.
    ; The value starts with the program's path, with or without quotes.
    StrCpy $R1 0
    metinbul_run_next:
      ClearErrors
      EnumRegValue $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R1
      IfErrors metinbul_run_done
      StrCmp $R2 "" metinbul_run_done
      ReadRegStr $R3 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R2
      StrCpy $R5 '"$INSTDIR\MetinBul.exe"'
      StrLen $R6 $R5
      StrCpy $R4 $R3 $R6
      StrCmp $R4 $R5 metinbul_run_ours
      StrCpy $R5 '$INSTDIR\MetinBul.exe'
      StrLen $R6 $R5
      StrCpy $R4 $R3 $R6
      StrCmp $R4 $R5 metinbul_run_ours metinbul_run_other
      metinbul_run_ours:
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R2
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" $R2
        Goto metinbul_run_next
      metinbul_run_other:
      IntOp $R1 $R1 + 1
      Goto metinbul_run_next
    metinbul_run_done:

    ; The index (the searchable text of the user's documents, and MetinBul's
    ; settings) and its key: asked, never taken for granted. A silent
    ; uninstall (/S) keeps them.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "MetinBul’un arama dizini de silinsin mi?$\r$\n$\r$\nDizin, belgelerinizin aranabilir metnini ve MetinBul ayarlarını içerir. Belgelerinizin kendisine dokunulmaz.$\r$\n$\r$\nMetinBul’u yeniden kuracaksanız Hayır’ı seçin: dizin yerinde kalır." /SD IDNO IDNO metinbul_keep_index
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$LOCALAPPDATA\MetinBul"
      RMDir /r "$APPDATA\MetinBul"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    metinbul_keep_index:

    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
  ${endIf}
!macroend
