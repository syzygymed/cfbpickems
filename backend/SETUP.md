# CFB Pickems — Backend Setup (Google Sheets)

This connects all players to ONE shared dataset using a free Google Sheet as the
database and Google Apps Script as the API. ~15 minutes, no credit card, no server.

---

## Part A — Stand up the backend (do this once)

### 1. Create the Sheet
1. Go to <https://sheets.google.com> → **Blank spreadsheet**.
2. Rename it something like **CFB Pickems DB**.

### 2. Add the script
1. In the Sheet: **Extensions → Apps Script**.
2. Delete the placeholder `function myFunction() {}`.
3. Open `backend/Code.gs` from this project, copy ALL of it, paste into the editor.
4. Click the **Save** icon (name the project "CFBP Backend").

### 3. Initialize (creates tabs + your secret token)
1. In the Apps Script toolbar, choose the function **`setup`** from the dropdown.
2. Click **Run**.
3. Google will ask for permission the first time → **Review permissions** →
   pick your account → **Advanced → Go to CFBP Backend (unsafe)** → **Allow**.
   (It says "unsafe" only because it's your own unverified script — it is your code.)
4. Open **View → Logs** (or **Execution log**). Copy the **token** it prints.
   - Lost it later? Run the **`logToken`** function and check the log again.

### 4. Deploy as a Web App
1. Top right: **Deploy → New deployment**.
2. Click the gear ⚙ next to "Select type" → **Web app**.
3. Settings:
   - **Description:** CFBP API
   - **Execute as:** **Me** (your account)
   - **Who has access:** **Anyone**  ← required so players' browsers can call it
4. **Deploy** → authorize again if asked → **copy the Web app URL**
   (it ends in `/exec`).

> ⚠️ Every time you change `Code.gs`, you must **Deploy → Manage deployments →
> edit (pencil) → Version: New version → Deploy** to publish the change. The
> `/exec` URL stays the same.

You now have two things:
- **Web App URL** (ends in `/exec`)
- **Token** (long random string)

---

## Part B — Connect the app

1. Open the app → **Commissioner** tab → log in (`admin123`).
2. Scroll to **☁️ Cloud Sync (Google Sheets)**.
3. Paste the **Web App URL** and **Token**.
4. Click **🔌 Test Connection** → expect "✅ Reached backend".
5. Click **💾 Save & Connect**.
6. First time only: click **⬆️ Push local data to Sheet (seed)** to upload your
   current players/weeks/games as the starting shared dataset.

That device is now using shared data. The header shows a **☁️ Synced** badge.

### Add the other players' devices
On each player's phone/computer:
1. Open the same app URL, enter the site PIN.
2. Commissioner tab isn't needed for them — but the **URL + token must be entered
   once** under Cloud Sync so their device points at the shared Sheet.
   - Simplest: you (commissioner) enter it for them, OR share the URL+token
     privately (treat the token like a house key).
3. They click **⬇️ Pull Sheet data to this device**, then use the app normally.

> Tip: bookmark/Add-to-Home-Screen AFTER connecting so it opens straight into the
> shared league.

---

## Part C — Season backups & rollback

In **Cloud Sync**:
- **📸 Create Snapshot** — saves a full timestamped copy into the Sheet's
  `CFBP_SNAPSHOTS` tab. Do this at the end of each week and end of season.
- **📜 List Snapshots → Restore** — rolls the shared data back to any snapshot.
  (A safety snapshot of current data is taken automatically before a restore.)

Previous seasons: create an end-of-season snapshot, then start the new season.
For full separation you can also duplicate the whole Google Sheet ("File → Make a
copy") to archive a finished season, and deploy a fresh one for the new year.

---

## How it works (for the curious)

- Every storage key the app used in `localStorage` (`cfbp_players`, `cfbp_games`,
  …) becomes one row in the `CFBP_STORE` tab: `key | json | updatedAt`.
- The app keeps an **in-memory mirror** of those values so all the existing
  synchronous code keeps working; writes are pushed to the Sheet in the
  background (debounced ~0.8s). Last write wins.
- **Session, site-PIN unlock, and the backend config never sync** — they're
  per-device by design.
- If the backend is unreachable at startup, the app **falls back to local mode**
  so it always works offline.

### Limits / caveats
- Apps Script free quota is generous for a small league (thousands of calls/day).
- This is "shared key, private URL" security — fine for friends, not for secrets.
  Rotate the token any time with the `rotateToken` function (re-enter it on each
  device afterward).
- Concurrency is last-write-wins. For a pick'em where people edit different rows,
  collisions are rare; the weekly snapshot is your safety net.
