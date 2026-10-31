# Uji 22 skenario check-in terhadap emulator Functions (khusus emulator).
# Jalankan SEKALI per seed baru, dan dalam 1 jam setelah seed.
$base = 'http://127.0.0.1:8787/api'

function Uji($member, $token, $session) {
  $body = @{ sessionId = $session; memberId = $member; token = $token } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method Post -Uri "$base/checkin" -ContentType 'application/json' -Body $body | Out-Null
    return 'OK'
  } catch {
    if ($_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    else { $text = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
    try { return ($text | ConvertFrom-Json).code } catch { return $text }
  }
}

$long = 'X' * 101

$cases = @(
  @{ n = '01 Andi, token benar';           m = 'm_andi';  t = 'ABC234';          s = 'sesi_uji';  e = 'OK' },
  @{ n = '02 Andi lagi (ganda)';           m = 'm_andi';  t = 'ABC234';          s = 'sesi_uji';  e = 'ALREADY_CHECKED_IN' },
  @{ n = '03 Budi (sudah Hadir)';          m = 'm_budi';  t = 'ABC234';          s = 'sesi_uji';  e = 'ALREADY_CHECKED_IN' },
  @{ n = '04 Citra (Izin)';                m = 'm_citra'; t = 'ABC234';          s = 'sesi_uji';  e = 'EXCUSED' },
  @{ n = '05 Eko (nonaktif)';              m = 'm_eko';   t = 'ABC234';          s = 'sesi_uji';  e = 'MEMBER_INVALID' },
  @{ n = '06 Fajar (belum di sesi)';       m = 'm_fajar'; t = 'ABC234';          s = 'sesi_uji';  e = 'OK' },
  @{ n = '07 Dewi, token simbol+spasi';    m = 'm_dewi';  t = 'hadir  #1   ok!'; s = 'sesi_uji';  e = 'OK' },
  @{ n = '08 Citra, token salah 1';        m = 'm_citra'; t = 'SALAH1';          s = 'sesi_uji';  e = 'TOKEN_INVALID' },
  @{ n = '09 Citra, token nonaktif 2';     m = 'm_citra'; t = 'OFFTKN';          s = 'sesi_uji';  e = 'TOKEN_INACTIVE' },
  @{ n = '10 Citra, token kedaluwarsa 3';  m = 'm_citra'; t = 'EXPIRD';          s = 'sesi_uji';  e = 'TOKEN_EXPIRED' },
  @{ n = '11 Citra, token salah 4';        m = 'm_citra'; t = 'SALAH2';          s = 'sesi_uji';  e = 'TOKEN_INVALID' },
  @{ n = '12 Citra, token salah 5';        m = 'm_citra'; t = 'SALAH3';          s = 'sesi_uji';  e = 'TOKEN_INVALID' },
  @{ n = '13 Citra, percobaan ke-6';       m = 'm_citra'; t = 'SALAH4';          s = 'sesi_uji';  e = 'TOO_MANY_ATTEMPTS' },
  @{ n = '14 Citra, token benar terkunci'; m = 'm_citra'; t = 'ABC234';          s = 'sesi_uji';  e = 'TOO_MANY_ATTEMPTS' },
  @{ n = '15 Nama kosong';                 m = '';        t = 'ABC234';          s = 'sesi_uji';  e = 'NO_MEMBER' },
  @{ n = '16 Token kosong';                m = 'm_andi';  t = '';                s = 'sesi_uji';  e = 'NO_TOKEN' },
  @{ n = '17 Token milik sesi lain';       m = 'm_andi';  t = 'ABC234';          s = 'sesi_lain'; e = 'TOKEN_INVALID' },
  @{ n = '18 ID anggota tidak ada';        m = 'm_zzz';   t = 'ABC234';          s = 'sesi_uji';  e = 'MEMBER_INVALID' },
  @{ n = '19 Token melewati batas 1 jam';  m = 'm_budi';  t = 'LAMA99';          s = 'sesi_uji';  e = 'TOKEN_EXPIRED' },
  @{ n = '20 Token 101 karakter';          m = 'm_budi';  t = $long;             s = 'sesi_uji';  e = 'TOKEN_INVALID' },
  @{ n = '21 Token hanya spasi';           m = 'm_andi';  t = '   ';             s = 'sesi_uji';  e = 'NO_TOKEN' },
  @{ n = '22 Token huruf kecil + spasi';   m = 'm_budi';  t = ' abc234  ';       s = 'sesi_uji';  e = 'ALREADY_CHECKED_IN' }
)

$pass = 0
foreach ($c in $cases) {
  $got = Uji $c.m $c.t $c.s
  if ($got -eq $c.e) { $mark = 'LULUS'; $pass++ } else { $mark = 'GAGAL' }
  '{0,-38} harapan={1,-20} hasil={2,-20} {3}' -f $c.n, $c.e, $got, $mark
}
"Hasil: $pass dari $($cases.Count) lulus"