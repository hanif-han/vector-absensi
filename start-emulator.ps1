# Menjalankan emulator Firebase. Aman: memakai proyek "demo-", jadi tidak
# pernah menyentuh data asli.

if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  $jbr = 'C:\Program Files\Android\Android Studio\jbr'
  if (Test-Path "$jbr\bin\java.exe") {
    $env:JAVA_HOME = $jbr
    $env:Path = "$jbr\bin;$env:Path"
    Write-Host "Memakai Java bawaan Android Studio: $jbr"
  } else {
    Write-Host 'Java tidak ditemukan. Pasang JDK 21 (adoptium.net), lalu buka PowerShell baru.'
    exit 1
  }
}

Set-Location $PSScriptRoot
firebase emulators:start --project demo-absensi-squad --only auth,firestore