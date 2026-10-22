# Zenith Gen Studio: design

Status: proposal, 22 Oct 2026. The build plan is at the bottom.

## In one paragraph

Build the hub as a **static website generated from one data file per app**, served free by
GitHub Pages. Binaries go in **GitHub Releases**, and a **single publish script on your PC**
does everything else. It uploads the build, checks it, records the version and pushes, and one
commit then updates the site, the download links and every app's update feed together. No
database, no server, no admin web page, no Vercel, no Firebase. Your PC only matters when you
publish. The site, downloads and update checks stay up 24/7 without it.

## What I found on your PC

1. **Bambowl's update check isn't live yet.** Bambowl 1.6.0 reads
   `https://tinypanda-collab.github.io/apps/bambowl.json`. That file exists only on your PC (the
   website folder isn't a git repo, and the file was added 21 Oct). Its APK link,
   `github.com/tinypanda-collab/bambowl/releases/...`, returns 404, so that repo is private or
   doesn't exist. Phones on 1.6.0 currently find nothing. That's harmless, because the code
   catches the error, but nothing will reach them until this is fixed. The fix is part of
   phase 2.
2. **The Windows builds are big.** Each Electron app is about 110 MB, and every release ships two
   of them (Setup and Portable), so about 220 MB. Four Windows apps x 10 versions comes to about
   9 GB. Firebase (5 GB), Supabase (1 GB) and Cloudflare R2's free tier (10 GB) would all fill up
   within months. Site hosts like Vercel, Cloudflare Pages and GitHub Pages can't hold these files
   at all: Cloudflare Pages caps each file at 25 MiB, and GitHub Pages caps the whole site at 1 GB.
3. **Your draft page has a "Studio Console" with an upload form inside the public page.** An admin
   UI in a public static page is either fake (localStorage) or needs real auth and a backend, and
   that's the part most likely to get hacked. The design keeps the storefront look and drops the
   console.
4. **Four public names are in play**: "T Panda Atelier" (current site), "TinyAi Projects"
   (account), "Zenith Gen Studio" (hub) and `tinypanda-collab` (GitHub username, which shows up in
   URLs). Pick one public name. A domain hides the GitHub username.
5. The privacy page that Google sign-in branding links to is `tinypanda-collab.github.io/privacy.html`.
   Turning that repo into the hub keeps that URL working without changing anything in Google Cloud.

## Review

**Good**
- Owning your own distribution, with no store review, no 15-30% cut and no ads, suits family
  apps and early builds.
- The "small JSON per app" update check is the right idea. It's simple, cacheable, and easy to
  move between hosts.
- Keeping builds and old versions on your PC means everything public can be rebuilt from your PC
  if a host disappears.

**Risky, and what the design does about it**

| Risk | Detail | Handling |
|---|---|---|
| A hosted admin page | It's another login to attack, and it needs a server, which has costs and goes to sleep (Supabase free projects pause after 7 idle days). | No admin page. Publishing is a script on your PC that uses your existing GitHub login. Nothing on the internet accepts uploads. |
| Update URLs tied to a host | Every app has its feed URL compiled in. Moving hosts would strand old installs. | Buy a domain (~US$10-12/yr) and give feeds a fixed path (`/api/<app>/android.json`). If you change host later, only DNS changes. |
| GitHub account takeover | Whoever controls the account controls the downloads. | Passkey + 2FA. Signing keys never go into GitHub. Android refuses an update signed with a different key, so a hijacked account still can't push a fake Bambowl update to existing phones. Windows `.exe` files have no such protection until they're code-signed. |
| Losing an Android keystore | Without it, nobody can update the app again. Family would have to uninstall, which loses local-only data such as Bambowl's gallery photos. | Keep two offline backups of `Signing Keys` plus one encrypted cloud copy. The publish script also checks every APK's certificate against a pinned fingerprint, which catches debug or wrong-key builds. |
| A bad release | Android can't downgrade to a lower versionCode without an uninstall. | "Pull" removes the build from the feed and the download buttons straight away. The fix is always a new, higher version. versionCodes are never reused. |
| File integrity | A corrupt or truncated upload, or a swapped file. | SHA-256 for every file, stored in the manifest, shown on the site and included in the feed. The script re-downloads each upload and compares hashes before the feed is changed. |
| Android install friction | "Install unknown apps" prompt, Play Protect warnings. | An install-help page with screenshots for each Android version. |
| **Android developer verification** | Google is requiring sideloaded apps on certified phones to come from a registered developer. It started 30 Sep 2026 in Brazil, Indonesia, Singapore and Thailand, and goes **global in 2027**, with no Malaysia date yet. Unregistered apps get blocked for new installs, apart from an "advanced flow" for experienced users and ADB. | Before Malaysia's date, register with full verification (US$25 one-time, government ID) and register `com.jon.bambowl` and the other packages with their **existing** keys. The free "limited distribution" account caps each app at 20 devices, and Bambowl has about 20 family accounts, so it's too tight. |
| Windows SmartScreen | Unsigned `.exe` files show "Windows protected your PC". | For now: an install-help page ("More info > Run anyway") plus the published SHA-256. Paid fix: an OV certificate (US$150-300/yr, hardware token). Microsoft's cheaper Artifact Signing (~US$9.99/mo) is only for individuals in the US and Canada. EV certificates no longer skip SmartScreen. A free alternative for an app that matures is the Microsoft Store (MSIX). |
| Pandoo going public | A Chromium build that falls behind on security patches puts its users at risk, because Chromium ships security fixes most weeks. Redistributing the **Widevine** CDM also needs a licence from Google. | Keep Pandoo **unlisted/private** until you can keep up with Chromium releases and have Widevine sorted (or ship it without Widevine). |
| Cypher Vault's extension | Chrome and Edge won't install a `.crx` from a website. Unpacked "developer mode" is the only route, and it shows warnings. | Chrome Web Store (US$5 one-time) and Edge Add-ons (free). Firefox lets you self-host a signed `.xpi`, which the hub can serve. Pandoo can bundle it. A password manager also deserves an outside review before it goes public. |
| Publicising a family app | A public Bambowl page means strangers can sign in. Supabase can take it, and shared AI already needs your approval, but quotas are shared. | Each app is `public`, `unlisted` (reachable by link, kept out of the list and search) or `private` (not on the hub). |
| Download counts | Counting usually means tracking. | GitHub counts each asset download itself. The nightly site rebuild reads those totals. No cookies, no IPs, nothing about people. Update checks aren't counted. |

**Rejected:** Vercel's free Hobby plan is for non-commercial use only, and a static site doesn't
need it. Firebase Storage now needs the Blaze (pay-as-you-go) plan for storage buckets, and 5 GB
is too small anyway. Supabase is the wrong place for binaries: 1 GB storage, 50 MB per file, and
the hub would eat Bambowl's quota.

## Architecture

```
 YOUR PC (only when publishing)              GITHUB (always on, free)                 PHONES / PCs
 ───────────────────────────────            ───────────────────────────             ───────────────
 Finished Apps\<App>\*.apk|.exe   ──zgs──▶  Releases (binaries, tag <app>-<ver>) ◀── download buttons
 zgs publish  (checks, hashes,               │                                          ▲
   uploads, verifies, commits)    ──git──▶  repo: data/apps/<app>.json (source of     │
                                             truth) + content/ + generator            │
                                             │ push → Actions builds site (+nightly)  │
                                             ▼                                          │
                                            GitHub Pages: site + /api/*.json  ─────────┘ daily update check
                                             (custom domain via Cloudflare DNS, optional)
```

### Repo layout (the `tinypanda-collab.github.io` repo becomes the hub)
```
data/site.json                 name, domain, contact, legacy aliases
data/apps/<id>.json            per app: text, platforms, signing fingerprint, visibility, releases[]
content/apps/<id>/             icon, screenshots (webp), privacy.md, long description
content/pages/                 install-help, about, combined privacy (keeps /privacy.html)
tools/build.mjs                generator, plain Node, no dependencies
tools/zgs.mjs                  publisher (runs on your PC), no dependencies
.github/workflows/site.yml     on push + nightly → build → deploy Pages
```

### Public URLs (the contract apps rely on)
| URL | What |
|---|---|
| `/` , `/apps/<id>/` , `/apps/<id>/privacy/` , `/install/` | Pages |
| `/api/<id>/android.json` | Android feed, Bambowl's existing format plus extra fields |
| `/api/<id>/windows.json` | Windows feed |
| `/api/<id>/releases.json` , `/api/catalog.json` | Full history and app list, for future in-app "what's new" or a launcher |
| `/get/<id>/<platform>` | Short link that always leads to the newest file. GitHub Pages can't do server redirects, so this is a tiny redirect page. |
| `/apps/bambowl.json` , `/privacy.html` | **Legacy aliases**, generated from the same data, so Bambowl 1.6.0 and Google branding keep working |

Android feed, compatible with what Bambowl already reads (Bambowl ignores fields it doesn't use):
```json
{"name":"1.6.1","code":8,"apk":"https://github.com/.../Bambowl-1.6.1.apk","notes":"one line",
 "sha256":"…","size":8044997,"published":"2026-10-23","page":"https://<hub>/apps/bambowl/"}
```

### Free-tier numbers (checked Oct 2026)
| Piece | Free limit | Your use |
|---|---|---|
| GitHub Releases | Under 2 GiB per file. GitHub doesn't cap total release size or download bandwidth. | 8-300 MB files. Fine. |
| GitHub Pages | Site 1 GB, ~100 GB/month bandwidth (soft), ~10 builds/hour | Site is a few MB, JSON feeds are tiny. Fine. |
| GitHub Actions | Free for public repos | Builds take ~30 s |
| Domain (optional) | about US$10-12/yr at Cloudflare Registrar (sold at cost) | One domain |

### If it grows
| Situation | Cost |
|---|---|
| Today, family plus a few people | **US$0** (+ domain ~US$10/yr) |
| Android verification, before Malaysia's 2027 date | US$25 one-time |
| Windows signing, once strangers install your apps | ~US$150-300/yr (OV cert), or the Microsoft Store at no cost |
| Chrome Web Store for Cypher Vault's extension | US$5 one-time |
| Leaving GitHub for files someday | Cloudflare R2: 10 GB free, then US$0.015/GB-month, free egress (100 GB is about US$1.35/mo). Only the links in `data/` change, and feed URLs stay the same. |

## Release workflow

```
1  Build finishes on your PC → lands in Finished Apps\<App> (as today)
2  Run:  zgs publish bambowl          (or double-click "Publish.cmd" and pick from the list)
3  zgs reads the build itself: version/versionCode/package id (aapt2) or the .exe version from its name
4  zgs CHECKS and stops on any failure:
     - versionCode higher than every version ever published (pulled ones included)
     - APK signed with the pinned certificate (catches debug/wrong-key builds)
     - package id matches; file isn't a key/secret; a version isn't published twice
5  You type one line of notes (≤200 chars, which is what Bambowl shows) and optionally longer notes
6  zgs hashes (SHA-256) → creates GitHub release "<app>-<version>" → uploads files
7  zgs re-downloads each file and compares hashes. Only then does it go on.
8  zgs adds the version to data/apps/<app>.json → commit → push
9  GitHub Actions rebuilds the site + feeds (~1 min) → one deploy changes page, buttons, feeds together
10 zgs waits until the live feed shows the new version, then prints "Live"
11 Phones: next daily check (≤20 h) or Help › Check for updates → "Bambowl 1.6.1 is ready" → Update
```
If any step fails, nothing public changes. Files can be uploaded and still unannounced, but a feed
never points at a missing file. Old versions stay listed on the app page with their hashes.

**Pull:** `zgs pull bambowl 1.6.1 "crashes on Android 10"`. The version leaves the feed and the
buttons, and the page shows it struck through with the reason. Its file stays on GitHub unless you
add `--delete-files`. Phones that already installed it need a newer fix.

## Build phases

| Phase | What | Test |
|---|---|---|
| 0 | Your decisions + accounts (below) | n/a |
| 1 | Generator + site using your Zenith design: app pages, versions, install help, privacy, feeds, legacy aliases. Data for Bambowl, Quillix Note, Cypher Vault. | Build runs locally. Feeds are checked against Bambowl's own parsing rules. Pages render on phone and desktop widths. Links checked. |
| 2 | Hub goes live in the GitHub repo, with Actions deploy and the nightly rebuild. Bambowl 1.6.0 uploaded as the first real release, which **fixes the dead update link**. | Live URLs return 200. The feed parses. The APK downloads and its hash matches. |
| 3 | `zgs` publisher: publish / pull / status / verify, plus a `--dry-run` mode | Dry run on real builds, then a real publish of the next Bambowl build |
| 4 | Point apps at the hub: Bambowl 1.6.1 moves to `/api/bambowl/android.json`; Quillix Note and Cypher Vault get the same small check (Android and Windows) | Install an old build, see the update bar, update |
| 5 | Optional: custom domain, a "Publish to Zenith" button in Windows App Studio, Firefox signed extension | n/a |
