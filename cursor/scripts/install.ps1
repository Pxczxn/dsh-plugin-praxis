param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'link.mjs') install @Rest
exit $LASTEXITCODE
