# Generates assets/icon.ico and assets/icon.png for the Windows build.
#
# The glyph is an arrow descending into a tray: the one symbol that still reads as
# "download" at 16 pixels. It is drawn from scratch - nothing here reproduces Hugging
# Face's logo or wordmark, because this is an unofficial project and borrowing their
# mark would contradict the disclaimer the README opens with.
#
# Colours match the app's own interface (#b8ed8a on #141b19), so the icon and the
# window look like the same product. The shape is a rounded square rather than the
# circle Local Model Bench uses, so the two are told apart at a glance in a taskbar.
#
# Every size is drawn at its own resolution rather than scaled down from one bitmap:
# a 16x16 downscale of a 256x256 drawing turns into grey mush, and the taskbar is
# where this icon is seen most.
Add-Type -AssemblyName System.Drawing

$assetDirectory = Join-Path $PSScriptRoot '..\assets'
New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null

$ground = [System.Drawing.Color]::FromArgb(255, 20, 27, 25)   # #141b19
$panel  = [System.Drawing.Color]::FromArgb(255, 41, 60, 34)   # #293c22
$accent = [System.Drawing.Color]::FromArgb(255, 184, 237, 138) # #b8ed8a

function New-RoundedPath {
    param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $R * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap {
    param([int]$Size)
    $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $s = [single]$Size
    $g.Clear([System.Drawing.Color]::Transparent)

    # Outer rounded square, inset slightly so the corners are not clipped.
    $inset = $s * 0.04
    $outer = New-RoundedPath -X $inset -Y $inset -W ($s - $inset * 2) -H ($s - $inset * 2) -R ($s * 0.22)
    $groundBrush = New-Object System.Drawing.SolidBrush $ground
    $g.FillPath($groundBrush, $outer)

    # Inner plate, which gives the glyph something to sit on at larger sizes. Below
    # about 32px it is indistinguishable from the ground, so it is skipped: drawing it
    # only adds a muddy one-pixel ring.
    if ($Size -ge 32) {
        $pad = $s * 0.10
        $inner = New-RoundedPath -X $pad -Y $pad -W ($s - $pad * 2) -H ($s - $pad * 2) -R ($s * 0.17)
        $panelBrush = New-Object System.Drawing.SolidBrush $panel
        $g.FillPath($panelBrush, $inner)
        $panelBrush.Dispose()
        $inner.Dispose()
    }

    # Below 24 pixels the tray and the arrowhead collapse into each other and the whole
    # thing reads as a green smudge. At those sizes the arrow alone is drawn, bigger, so
    # the silhouette stays legible - dropping detail rather than shrinking it is how an
    # icon survives the taskbar.
    $tiny = $Size -lt 24

    $weight = if ($tiny) { [Math]::Max($s * 0.135, 2.0) } else { [Math]::Max($s * 0.088, 2.0) }
    $pen = New-Object System.Drawing.Pen $accent, $weight
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    if ($tiny) {
        # Arrow only, filling the tile.
        $g.DrawLine($pen, [single]($s * 0.5), [single]($s * 0.22), [single]($s * 0.5), [single]($s * 0.66))
        $head = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([single]($s * 0.28), [single]($s * 0.47))),
            (New-Object System.Drawing.PointF ([single]($s * 0.5),  [single]($s * 0.70))),
            (New-Object System.Drawing.PointF ([single]($s * 0.72), [single]($s * 0.47)))
        )
        $g.DrawLines($pen, $head)
    }
    else {
        # Arrow: vertical stem, then a chevron head. Kept narrower and shorter than the
        # tile allows, so the glyph has room to breathe inside the plate.
        $g.DrawLine($pen, [single]($s * 0.5), [single]($s * 0.275), [single]($s * 0.5), [single]($s * 0.545))
        $head = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([single]($s * 0.365), [single]($s * 0.435))),
            (New-Object System.Drawing.PointF ([single]($s * 0.5),   [single]($s * 0.567))),
            (New-Object System.Drawing.PointF ([single]($s * 0.635), [single]($s * 0.435)))
        )
        $g.DrawLines($pen, $head)

        # Tray: a base with two short uprights, so it reads as somewhere to land rather
        # than as an underline.
        $tray = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([single]($s * 0.315), [single]($s * 0.645))),
            (New-Object System.Drawing.PointF ([single]($s * 0.315), [single]($s * 0.725))),
            (New-Object System.Drawing.PointF ([single]($s * 0.685), [single]($s * 0.725))),
            (New-Object System.Drawing.PointF ([single]($s * 0.685), [single]($s * 0.645)))
        )
        $g.DrawLines($pen, $tray)
    }

    $pen.Dispose(); $groundBrush.Dispose(); $outer.Dispose(); $g.Dispose()
    return $bitmap
}

# 256 must be present for electron-builder; the rest are the sizes Windows actually
# asks for in Explorer, the taskbar, and Alt-Tab.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bitmap = New-IconBitmap -Size $size
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += , @{ Size = $size; Bytes = $stream.ToArray() }
    if ($size -eq 256) { $bitmap.Save((Join-Path $assetDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    $stream.Dispose(); $bitmap.Dispose()
}

# ICO container: a 6-byte header, one 16-byte directory entry per image, then the PNG
# payloads. PNG-compressed entries are what modern Windows expects.
$icoPath = Join-Path $assetDirectory 'icon.ico'
$stream = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($image in $images) {
    # 256 is stored as 0 in a single byte, which is what the format calls for.
    $dimension = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $image.Bytes.Length
}
foreach ($image in $images) { $writer.Write($image.Bytes) }
$writer.Dispose(); $stream.Dispose()

Write-Output ("Wrote {0} ({1} sizes: {2}) and icon.png" -f $icoPath, $images.Count, ($sizes -join ', '))
