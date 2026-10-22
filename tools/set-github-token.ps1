# Saves a GitHub fine-grained token as this PC's git login for github.com, replacing the old one.
# git push and Publish.cmd (zgs) both use it. The token is typed into this window only; it is
# never written to a file, printed, or sent anywhere except GitHub (to check it works).
$ErrorActionPreference = 'Stop'
$repo = 'tinypanda-collab/tinypanda-collab.github.io'
Write-Host "Paste the new GitHub token (it won't show), then press Enter:" -ForegroundColor Cyan
$sec = Read-Host -AsSecureString
$tok = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
if (-not $tok.StartsWith('github_pat_')) { Write-Host 'That does not look like a fine-grained token (github_pat_...). Nothing changed.' -ForegroundColor Red; exit 1 }
$h = @{ Authorization = "Bearer $tok"; 'User-Agent' = 'zgs'; Accept = 'application/vnd.github+json' }
try { $r = Invoke-RestMethod "https://api.github.com/repos/$repo" -Headers $h } catch { Write-Host "GitHub refused the token: $($_.Exception.Message). Nothing changed." -ForegroundColor Red; exit 1 }
if (-not $r.permissions.push) { Write-Host 'The token cannot write to the repo (needs Contents: Read and write). Nothing changed.' -ForegroundColor Red; exit 1 }
# remove the old saved logins, then save the new one
"protocol=https`nhost=github.com`n`n" | git credential reject
"protocol=https`nhost=github.com`nusername=hub-default-github`n`n" | git credential reject
"protocol=https`nhost=github.com`nusername=tinypanda-collab`npassword=$tok`n`n" | git credential approve
$tok = $null
$env:GIT_TERMINAL_PROMPT = '0'
Push-Location (Split-Path $PSScriptRoot)
git ls-remote --heads origin main | Out-Null
$ok = $LASTEXITCODE -eq 0
Pop-Location
if ($ok) { Write-Host 'Saved. git and Publish.cmd now use the new token.' -ForegroundColor Green
  Write-Host 'Last step: delete the old classic token at https://github.com/settings/tokens' -ForegroundColor Yellow }
else { Write-Host 'Saved, but git could not reach the repo with it. Tell Claude.' -ForegroundColor Red }
