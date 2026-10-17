# Speed Fluctuation Monitor

Every hour, measures 4 sites with Lighthouse (the engine behind Google PageSpeed Insights, same
mobile/desktop settings) and shows a public report: does waritex fluctuate alone, or with everyone?

```
GitHub Actions (free, hourly)            Hostinger shared hosting
runner/run.js  -- Chrome + Lighthouse -->  receive.php  -> data/results.csv
                    POST results           index.html   <- anyone with the link
```

Shared hosting cannot run Chrome, so the measuring runs on GitHub's servers and only the
report lives on Hostinger.

| Folder | Goes to | Contents |
|---|---|---|
| `hostinger/` | Hostinger | `index.html` report, `receive.php` upload endpoint, `config.php` token, `.htaccess` |
| `runner/` + `.github/` | GitHub repository | Lighthouse runner and the hourly schedule |

## Step 1 - Create the upload password

A long random string shared by GitHub and Hostinger. Generate one in PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

Keep it for steps 2 and 4.

## Step 2 - Hostinger: upload the report

1. hPanel > Domains > Subdomains: create `speed` (gives `speed.waritex.com`).
2. hPanel > File Manager: open the subdomain's folder.
3. Upload `hostinger.zip` and Extract it there.
4. Edit `config.php`: paste the password into `'upload_token' => ''`. Save.
5. Open `https://speed.waritex.com/` - it should say "No measurements yet."

## Step 3 - GitHub: upload the runner

1. Sign up at https://github.com (free).
2. New repository: name `speed-monitor`, **Public** (public repos get unlimited free Actions minutes;
   a private repo would run out after ~5 days of hourly rounds).
3. "uploading an existing file": drag in everything inside the `github-upload` folder
   (`.github`, `runner`, `.gitignore`, `README.md`). Commit.

## Step 4 - GitHub: add the two secrets

Repository > Settings > Secrets and variables > Actions > New repository secret:

| Name | Value |
|---|---|
| `UPLOAD_URL` | `https://speed.waritex.com/receive.php` |
| `UPLOAD_TOKEN` | the password from step 1 |

## Step 5 - First run

1. Repository > Actions > "speed-monitor" > Run workflow.
2. After ~15 minutes the run turns green. Open its log: each site shows `score=...` and the
   last line says `uploaded N rows`.
3. Refresh `https://speed.waritex.com/` - the first round is there.

From now on it runs every hour by itself (GitHub may start a run a few minutes late).

## Changing the sites

Edit `runner/config.json` in the GitHub repository (pencil icon). The next round uses the new list.
The first site in the list is the one the report compares against all the others.

## Reading the report

- **...with no other site**: waritex dipped while the other sites were fine = waritex's own server/pages.
- **...with most others**: everyone dipped together = measuring side (machine / network), not waritex.
- **Slow-machine rounds**: GitHub's machine ran 30%+ slower than usual; ignore dips in those rounds.
- **TTFB**: spikes here mean waritex's server was slow to answer (hosting / cache), not the page design.
- **Average score by hour of day**: hours that are always worse point to server load or scheduled jobs.

Scores will not match pagespeed.web.dev exactly (different machine and location).
For comparing the sites with each other and spotting fluctuation, that does not matter: all sites are
measured by the same machine in the same round.
