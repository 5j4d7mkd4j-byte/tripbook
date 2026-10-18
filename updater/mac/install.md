# Mac backup updater

GitHub Actions (`.github/workflows/live.yml`) is the main updater. This Mac job is
the backup: launchd starts `run_mac.sh` every 10 minutes, `run.py` checks whether a
run is due (travel window, or a 2-hour slow tick between 18 and 30 Oct) and skips
when the cloud published a good status in the last 12 minutes (2 h 5 min on slow
ticks). It only runs while the Mac is awake and logged in.

## Before you start

1. **Use a clone outside Desktop, Documents and Downloads.** macOS privacy
   controls block launchd jobs from those folders unless you grant bash and
   python3 Full Disk Access. The simplest fix is a separate clone:

   ```sh
   git clone https://github.com/5j4d7mkd4j-byte/tripbook.git ~/tripbook
   ```

2. **Give the clone the key.** `.secrets/` is gitignored, so copy it across
   (never commit it, never print it):

   ```sh
   cp -R "$HOME/Desktop/Brown/Coding/Claude/New York/.secrets" ~/tripbook/
   chmod 700 ~/tripbook/.secrets
   ```

   `docs/data/trip.bin` comes with the clone. After changing `trip/flights.json`,
   rebuild with `node app/build.mjs` and push, or the updaters keep the old legs.

3. **Check that git can push without prompting** (the job cannot answer a prompt):

   ```sh
   cd ~/tripbook && git push --dry-run origin HEAD
   ```

4. **Try one run by hand:**

   ```sh
   cd ~/tripbook
   python3 updater/run.py --force --source mac   # writes updater/out/status.bin
   python3 updater/run.py --check updater/out/status.bin
   bash updater/publish.sh                       # pushes it to the live branch
   ```

## Install

```sh
ROOT="$HOME/tripbook"
mkdir -p "$ROOT/updater/state" ~/Library/LaunchAgents
sed "s|__ROOT__|$ROOT|g" "$ROOT/updater/mac/com.tripbook.updater.plist" \
  > ~/Library/LaunchAgents/com.tripbook.updater.plist
plutil -lint ~/Library/LaunchAgents/com.tripbook.updater.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tripbook.updater.plist
```

It runs once at load and then every 10 minutes.

## Check on it

```sh
launchctl print gui/$(id -u)/com.tripbook.updater | grep -E "state|last exit"
tail -n 30 ~/tripbook/updater/state/launchd.log
launchctl kickstart -k gui/$(id -u)/com.tripbook.updater   # run now
```

Most log entries read `skipped: ...`; that is the window check working.
`updater/state/launchd.err` only fills if launchd could not start the script.

## Remove after the trip

```sh
launchctl bootout gui/$(id -u)/com.tripbook.updater
rm ~/Library/LaunchAgents/com.tripbook.updater.plist
```

## The cloud side, for reference

The workflow needs the key as a repository secret. This reads the file straight
into the secret without printing it:

```sh
gh secret set TRIP_KEY --repo 5j4d7mkd4j-byte/tripbook < .secrets/trip_key.b64
```

`.secrets/trip_key.b64` is written the first time `tools/tripcrypt.mjs` derives
the key from the passphrase (for example by `node app/build.mjs`). Run the
workflow once from the Actions tab (Run workflow, force on) to check it, and
disable it after the trip.
