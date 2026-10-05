# Writes this machine's orchvis config, ~/.orchvis/config.json, with the broker
# URL and the shim token. Options pass through to setup.mjs (try --help):
#   --broker-url URL   --token TOKEN   --from-broker-config [PATH]
# Without them it prompts; the token prompt does not echo. The token is handed
# to Node through an environment variable for that one process, never echoed.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'orchvis needs Node.js 20 or later, and node was not found on PATH.'
    Write-Host 'Install it from https://nodejs.org, then run this again.'
    exit 1
}
$setup = Join-Path $PSScriptRoot 'setup.mjs'
$given = @($args | ForEach-Object { "$_" })
if ($given -contains '--help' -or $given -contains '-h') {
    & node $setup --help
    exit $LASTEXITCODE
}

$passArgs = @($given)
if (-not ($given -contains '--broker-url') -and -not $env:ORCHVIS_BROKER_URL -and -not ($given -contains '--from-broker-config')) {
    $url = Read-Host 'Broker URL (e.g. ws://broker-host:7801)'
    if ($url) { $passArgs += @('--broker-url', $url) }
}
$hadToken = [bool]$env:ORCHVIS_TOKEN
if (-not ($given -contains '--token') -and -not $hadToken -and -not ($given -contains '--from-broker-config')) {
    $secure = Read-Host 'Shim token (not echoed)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:ORCHVIS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
try {
    & node $setup --yes @passArgs
    $code = $LASTEXITCODE
} finally {
    if (-not $hadToken) { Remove-Item Env:ORCHVIS_TOKEN -ErrorAction SilentlyContinue }
}
exit $code
