Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "..\..\ADT Digital Tech Logo.png"
if (-not (Test-Path $srcPath)) {
    $srcPath = Join-Path $PSScriptRoot "..\src\assets\adt-logo.png"
}

$srcImage = [System.Drawing.Image]::FromFile($srcPath)
$resDir = Join-Path $PSScriptRoot "..\android\app\src\main\res"
$webLogoPath = Join-Path $PSScriptRoot "..\src\assets\adt-logo.png"

$densities = @(
    @{ name = "mipmap-mdpi";    iconSize = 48;  fgSize = 108 },
    @{ name = "mipmap-hdpi";    iconSize = 72;  fgSize = 162 },
    @{ name = "mipmap-xhdpi";   iconSize = 96;  fgSize = 216 },
    @{ name = "mipmap-xxhdpi";  iconSize = 144; fgSize = 324 },
    @{ name = "mipmap-xxxhdpi"; iconSize = 192; fgSize = 432 }
)

function Resize-Image($image, $targetWidth, $targetHeight, $destPath, [bool]$contain = $false) {
    $bmp = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($contain) {
        # Keep aspect ratio and center with padding (useful for adaptive foreground)
        $ratio = [Math]::Min($targetWidth / $image.Width, $targetHeight / $image.Height) * 0.75
        $destW = [int]($image.Width * $ratio)
        $destH = [int]($image.Height * $ratio)
        $destX = [int](($targetWidth - $destW) / 2)
        $destY = [int](($targetHeight - $destH) / 2)
        $g.DrawImage($image, $destX, $destY, $destW, $destH)
    } else {
        $ratio = [Math]::Min($targetWidth / $image.Width, $targetHeight / $image.Height)
        $destW = [int]($image.Width * $ratio)
        $destH = [int]($image.Height * $ratio)
        $destX = [int](($targetWidth - $destW) / 2)
        $destY = [int](($targetHeight - $destH) / 2)
        $g.DrawImage($image, $destX, $destY, $destW, $destH)
    }

    $bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

foreach ($d in $densities) {
    $targetDir = Join-Path $resDir $d.name
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

    $iconPath = Join-Path $targetDir "ic_launcher.png"
    $roundPath = Join-Path $targetDir "ic_launcher_round.png"
    $fgPath = Join-Path $targetDir "ic_launcher_foreground.png"

    Resize-Image $srcImage $d.iconSize $d.iconSize $iconPath $false
    Resize-Image $srcImage $d.iconSize $d.iconSize $roundPath $false
    Resize-Image $srcImage $d.fgSize $d.fgSize $fgPath $true

    Write-Output "Generated icons in $($d.name) (icon: $($d.iconSize)x$($d.iconSize), fg: $($d.fgSize)x$($d.fgSize))"
}

Resize-Image $srcImage 384 384 $webLogoPath $false
Write-Output "Generated web logo: $webLogoPath"

$srcImage.Dispose()
Write-Output "All ADT Monitoring app icons generated successfully!"
