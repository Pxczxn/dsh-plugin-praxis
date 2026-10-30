param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'profile.mjs') install @Rest
exit $LASTEXITCODE
