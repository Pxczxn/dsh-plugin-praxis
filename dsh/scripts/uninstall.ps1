param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'profile.mjs') uninstall @Rest
exit $LASTEXITCODE
