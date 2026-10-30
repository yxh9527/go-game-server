param([string]$HallRoot = (Join-Path $PSScriptRoot '../static/hall'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../static/client/2.0.1279/assets/resources'))
$texturePath = Join-Path $resourceRoot 'native/91/91aa3baa-8d90-4b46-ac1e-fb412002c883.68cc7.png'
$packPath = Join-Path $resourceRoot 'import/02/028204d4b.25da7.json'
$pack = Get-Content -LiteralPath $packPath -Raw -Encoding UTF8 | ConvertFrom-Json
$frames = @{}
foreach ($record in $pack[5]) {
    foreach ($item in $record[0]) {
        if ($item -is [pscustomobject] -and $null -ne $item.rect) { $frames[$item.name] = $item }
    }
}
foreach ($name in @('hold_v_0','hold_v_1','0','1','2','3','4','5','6','7','8','29')) {
    if (-not $frames.ContainsKey($name)) { throw "Original Mahjong frame is missing: $name" }
}
$directory = [IO.Path]::GetFullPath((Join-Path $HallRoot 'l01/img/room/type/1000/62'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$texture = [Drawing.Bitmap]::new($texturePath)
function Read-Frame([string]$Name) {
    $frame = $frames[$Name]
    $width = [int]$frame.rect[2]; $height = [int]$frame.rect[3]
    $packedWidth = $width; $packedHeight = $height
    if ($frame.rotated) { $packedWidth = $height; $packedHeight = $width }
    $rect = [Drawing.Rectangle]::new([int]$frame.rect[0], [int]$frame.rect[1], $packedWidth, $packedHeight)
    $image = $texture.Clone($rect, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    if ($frame.rotated) { $image.RotateFlip([Drawing.RotateFlipType]::Rotate270FlipNone) }
    if ($image.Width -ne $width -or $image.Height -ne $height) {
        $image.Dispose(); throw "Original Mahjong frame dimensions do not match: $Name"
    }
    return $image
}
$created = @(); $existing = @()
try {
    foreach ($id in @(-1,0,1,2,3,4,5,6,7,8,29)) {
        $destination = Join-Path $directory "$id.png"
        if (Test-Path -LiteralPath $destination) { $existing += $id; continue }
        # Same upright empty/front backgrounds used by the original JsmjCard.
        $background = if ($id -eq -1) { 'hold_v_0' } else { 'hold_v_1' }
        $image = Read-Frame $background
        try {
            if ($id -ne -1) {
                $face = Read-Frame ([string]$id)
                $graphics = [Drawing.Graphics]::FromImage($image)
                try {
                    $graphics.DrawImageUnscaled($face, [int](($image.Width-$face.Width)/2), [int](($image.Height-$face.Height)/2))
                } finally { $graphics.Dispose(); $face.Dispose() }
            }
            $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose() }
            $created += $id
        } finally { $image.Dispose() }
    }
} finally { $texture.Dispose() }
[pscustomobject]@{ directory = $directory; created = @($created); existing = @($existing) } | ConvertTo-Json -Compress
