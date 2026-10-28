param([switch]$FetchDependencies)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:RUSTUP_HOME = Join-Path $root 'artifacts/toolchains/rustup'
$env:CARGO_HOME = Join-Path $root 'artifacts/toolchains/cargo'
$env:RUSTUP_INIT_SKIP_PATH_CHECK = 'yes'
Remove-Item Env:RUSTUP_TOOLCHAIN -ErrorAction SilentlyContinue
$cargo = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
$rustup = Join-Path $env:CARGO_HOME 'bin/rustup.exe'
$bootstrap = Join-Path $root 'artifacts/toolchains/downloads/rustup-init.exe'
$source = 'https://win.rustup.rs/x86_64'
$expected = '00f139da614dced87d3c3d4121c43eebdac3c1bf8a5ee86b9d80dfd71c8d70fd'
if (-not (Test-Path -LiteralPath $cargo)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $bootstrap) | Out-Null
    if (-not (Test-Path -LiteralPath $bootstrap)) {
        curl.exe -fLsS -o $bootstrap $source
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if ((Get-FileHash -Algorithm SHA256 $bootstrap).Hash.ToLowerInvariant() -ne $expected) {
        throw 'The official bootstrap differs from the recorded hash. Do not run it automatically.'
    }
    & $bootstrap -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain 1.99.1
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$version = & (Join-Path $env:CARGO_HOME 'bin/rustc.exe') --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^rustc 1\.99\.1 ') { throw 'The isolated toolchain has a different version; it was not replaced.' }
$active = & $rustup show active-toolchain
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$name = ($active -split ' ')[0]
if ($name -notin @('stable-x86_64-pc-windows-gnu', '1.99.1-x86_64-pc-windows-gnu')) { throw 'Unexpected isolated toolchain name.' }
$receipt = [ordered]@{
    source = $source
    bootstrap_sha256 = (Get-FileHash -Algorithm SHA256 $bootstrap).Hash.ToLowerInvariant()
    bootstrap_authenticode = [string](Get-AuthenticodeSignature $bootstrap).Status
    toolchain = $name
    rustc = $version
    cargo = [string](& $cargo --version)
    distribution = 'https://static.rust-lang.org/'
    global_path_changed = $false
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'artifacts/toolchains/receipt.json') -Encoding utf8
Write-Output ($receipt | ConvertTo-Json -Compress)
if ($FetchDependencies) {
    & $cargo fetch --manifest-path (Join-Path $root 'poc/controller/Cargo.toml') --locked
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
