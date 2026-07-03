Add-Type -AssemblyName System.Drawing
$inputPath = "d:\Demo\OFresh\OFresh_Logo.png"
$outputPath = "d:\Demo\OFresh\OFresh_Logo_transparent.png"

$img = [System.Drawing.Image]::FromFile($inputPath)
$bmp = New-Object System.Drawing.Bitmap($img)
$img.Dispose()

# Make pure white transparent
$whiteColor = [System.Drawing.Color]::FromArgb(255, 255, 255)
$bmp.MakeTransparent($whiteColor)

# Also make slightly off-white transparent (optional, but MakeTransparent only takes one color)
# If there are off-white pixels, we can also scan them, but let's see how MakeTransparent works first.
$bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Transparent logo saved to $outputPath"
