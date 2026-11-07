; Explorer's "Open in Bashboard" (docs/design/app.md section 3.18). Per-user keys, matching the
; currentUser install mode. On Windows 11 these appear under "Show more options".

!macro BASHBOARD_ADD_VERB ROOT ARG
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Bashboard" "" "Open in Bashboard"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Bashboard" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Bashboard\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "${ARG}"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Inside a folder (empty space), on a folder, and on a drive.
  !insertmacro BASHBOARD_ADD_VERB "Directory\Background" "%V"
  !insertmacro BASHBOARD_ADD_VERB "Directory" "%V"
  !insertmacro BASHBOARD_ADD_VERB "Drive" "%V"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Bashboard"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Bashboard"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Bashboard"
!macroend
