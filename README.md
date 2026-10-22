# Zenith Gen Studio

The public home for the apps. It has a page for each app with downloads, every older version,
install help, privacy policies, and the small "latest version" files the apps check for updates.

Live at **https://tinypanda-collab.github.io**, a free GitHub Pages site built from this repo.
Builds are stored as files on this repo's **Releases**. Nothing runs on your PC except when you
publish. `DESIGN.md` explains why it's built this way.

## Publish a new build

1. Build as usual. The files land in `Finished Apps\<App>`.
2. Double-click **Publish.cmd** and type the app id, or run:
   ```
   node tools/zgs.mjs publish bambowl --dry-run     # checks only
   node tools/zgs.mjs publish bambowl
   ```
3. Type one line of what's new and confirm. zgs then does the rest:
   - checks the version is newer and the versionCode is higher
   - checks the APK is signed with the app's release key, not the debug key
   - uploads the files to a GitHub release, downloads them again, and compares the SHA-256
   - records the version in `data/apps/<app>.json`, commits and pushes
   - waits until the live update feed shows the new version

If anything fails, nothing public changes. Running the same command again resumes where it stopped.

| Task | Command |
|---|---|
| Withdraw a bad version | `node tools/zgs.mjs pull bambowl 1.6.1 --reason "Crashes on Android 10"` |
| Add an old build to the history | `node tools/zgs.mjs publish bambowl --backfill --from "...\_Previous releases\Bambowl 1.5.0" --date 2026-10-14 --notes "…"` |
| See versions, the live feed, and download counts | `node tools/zgs.mjs status` |
| Check that every download link works | `node tools/zgs.mjs verify` (add `--deep` to re-hash every file) |

**Rules that keep phones updating:**
- Never reuse or lower a versionCode.
- A pulled version stays on phones that already installed it. Fix it by releasing a newer version.
- Keep `Signing Keys` backed up offline. Without a key, its app can never be updated again.

## Where things are

| Path | What |
|---|---|
| `data/site.json` | Site name, address, contact email, and old URLs kept working (`legacyFeeds`) |
| `data/apps/<id>.json` | One app: text, platforms, signing-key fingerprint, `visibility` (public, unlisted or private), and all releases |
| `content/apps/<id>/` | `icon.webp`, `shots/*.webp`, and `privacy.html` (that app's section of the privacy policy) |
| `content/privacy/` | Privacy policy sections shared by every app |
| `tools/build.mjs` | Generates the site into `dist/`. `node tools/build.mjs --no-counts` to preview |
| `tools/test.mjs` | Checks feeds, links, pulled versions and the rules. Runs before every deploy |
| `tools/zgs.mjs` | Publisher (above). `tools/zgs.config.json` maps app ids to `Finished Apps` folders |
| `.github/workflows/site.yml` | Builds and deploys on every push, plus nightly to refresh download counts |

## URLs the apps depend on (don't change these)

- `/api/<id>/android.json`: `{"name","code","apk","notes","sha256","size","published","page"}`
- `/api/<id>/windows.json`: `{"name","notes","published","page","files":{"setup":{url,size,sha256},"portable":{…}}}`
- `/apps/bambowl.json`: the old address that Bambowl 1.6.0 and earlier read. Same content as the new feed.
- `/privacy.html`: linked from Google sign-in branding

## Adding an app

1. Create `data/apps/<id>.json` (copy an existing one). For Android, get the `certSha256` with
   `apksigner verify --print-certs <apk>`.
2. Put `icon.webp` (256×256) and any screenshots in `content/apps/<id>/`.
3. Add the app's `Finished Apps` folder to `tools/zgs.config.json`, commit, then publish.

## Previewing locally

```
node tools/build.mjs --no-counts
npx serve dist        # or: python -m http.server -d dist
```

## GitHub login for zgs

zgs reuses the login git already saved on this PC. If GitHub refuses it, create a
**fine-grained token** (GitHub › Settings › Developer settings), limited to this repository with
*Contents: Read and write*. Store it in your password manager, and set it for zgs with
`setx ZGS_GITHUB_TOKEN <token>`.
