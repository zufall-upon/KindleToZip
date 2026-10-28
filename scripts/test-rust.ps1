$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:RUSTUP_HOME = Join-Path $root 'artifacts/toolchains/rustup'
$env:CARGO_HOME = Join-Path $root 'artifacts/toolchains/cargo'
$env:CARGO_TARGET_DIR = Join-Path $root 'artifacts/rust-target'
$receipt = Get-Content -LiteralPath (Join-Path $root 'artifacts/toolchains/receipt.json') -Raw | ConvertFrom-Json
if ($receipt.toolchain -notin @('stable-x86_64-pc-windows-gnu', '1.99.1-x86_64-pc-windows-gnu')) { throw 'Unexpected isolated toolchain name.' }
$env:RUSTUP_TOOLCHAIN = $receipt.toolchain
$cargo = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
$rustc = Join-Path $env:CARGO_HOME 'bin/rustc.exe'
Push-Location $root
try {
    $version = & $rustc --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^rustc 1\.99\.1 ') { throw 'The isolated Rust version differs from the recorded toolchain.' }
    Write-Output $version
    & $cargo test --manifest-path poc/controller/Cargo.toml --locked --offline
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $cargo build --manifest-path poc/controller/Cargo.toml --locked --offline
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:CARGO_TARGET_DIR = Join-Path $root 'artifacts/toolchains/launcher-target'
    & $cargo test --manifest-path poc/launcher/Cargo.toml --locked --offline
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:CARGO_TARGET_DIR = Join-Path $root 'artifacts/rust-target'
    node --test tests/rust-ipc.test.mjs tests/local-store.test.mjs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
