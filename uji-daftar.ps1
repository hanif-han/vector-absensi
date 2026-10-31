# Uji pendaftaran akun TANPA kode (khusus emulator). Jalankan SEKALI per emulator baru.
$base = 'http://127.0.0.1:8787/api'

function Daftar($email, $pass, $name) {
  $body = @{ email = $email; password = $pass; displayName = $name } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method Post -Uri "$base/register" -ContentType 'application/json' -Body $body | Out-Null
    return 'OK'
  } catch {
    if ($_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    else { $text = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
    try { return ($text | ConvertFrom-Json).code } catch { return $text }
  }
}

$cases = @(
  @{ n = '01 Daftar tanpa kode';            a = @('tes1@example.com',  'Password123', 'Tes Anggota'); e = 'OK' },
  @{ n = '02 Email sama lagi';              a = @('tes1@example.com',  'Password123', 'Tes Anggota'); e = 'EMAIL_EXISTS' },
  @{ n = '03 Email sama (huruf besar)';     a = @('TES1@EXAMPLE.COM',  'Password123', 'Tes Anggota'); e = 'EMAIL_EXISTS' },
  @{ n = '04 Password terlalu pendek';      a = @('tes3@example.com',  'abc12',       'Tes Tiga');    e = 'BAD_PASSWORD' },
  @{ n = '05 Format email salah';           a = @('bukan-email',       'Password123', 'Tes Empat');   e = 'BAD_EMAIL' },
  @{ n = '06 Nama terlalu pendek';          a = @('tes5@example.com',  'Password123', 'A');           e = 'BAD_NAME' },
  @{ n = '07 Pendaftar kedua';              a = @('tes6@example.com',  'Password123', 'Tes Enam');    e = 'OK' },
  @{ n = '08 Email salah (percobaan 8)';    a = @('salah8',            'Password123', 'Tes Delapan'); e = 'BAD_EMAIL' },
  @{ n = '09 Nama salah (percobaan 9)';     a = @('tes9@example.com',  'Password123', 'B');           e = 'BAD_NAME' },
  @{ n = '10 Password salah (percobaan 10)'; a = @('tes10@example.com', 'pendek',      'Tes Sepuluh'); e = 'BAD_PASSWORD' },
  @{ n = '11 Percobaan ke-11 (diblokir)';   a = @('tes11@example.com', 'Password123', 'Tes Sebelas'); e = 'TOO_MANY_ATTEMPTS' }
)

$pass = 0
foreach ($c in $cases) {
  $got = Daftar $c.a[0] $c.a[1] $c.a[2]
  if ($got -eq $c.e) { $mark = 'LULUS'; $pass++ } else { $mark = 'GAGAL' }
  '{0,-38} harapan={1,-20} hasil={2,-20} {3}' -f $c.n, $c.e, $got, $mark
}
"Hasil: $pass dari $($cases.Count) lulus"