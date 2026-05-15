# QuickTiming

Multi-user track &amp; field timing for small meets. Anyone with the URL can assign bibs, line up races, start the timer, tap finishers, record long jumps, and view live results. All phones stay in sync via WebSockets.

## Run locally

```powershell
npm install
npm start
```

Server starts at `http://localhost:3000`.

To use from multiple phones on the same Wi-Fi, find this machine's LAN IP (`ipconfig`) and open `http://<lan-ip>:3000` on each phone.

## Run over cell signal (multi-user)

The app needs to be reachable from the public internet. Easiest options:

- **Deploy to Render / Railway / Fly.io / Heroku** — push the repo, set the start command to `npm start`. They expose a public HTTPS URL.
- **Quick public tunnel for one event** — install [ngrok](https://ngrok.com) and run:
  ```powershell
  npm start
  # in another terminal:
  ngrok http 3000
  ```
  Share the `https://*.ngrok-free.app` URL with the operators.

## How it works

- **Bibs tab** — anyone assigns bib → name. Updates broadcast to all phones.
- **100m / 400m tabs** — operator adds bibs to the starting line-up, hits **Start Race**. Server-side clock starts. Every connected phone sees the live timer. When a finisher crosses, the finish-line operator taps that bib and the time is recorded (server-authoritative).
- **Long Jump tab** — select the jumper, enter feet + inches, hit Record. Best jump per athlete is highlighted.
- **Results tab** — live standings for all three events, plus:
  - **View Results Page** — `/export.html` rendered server-side (always current).
  - **Download HTML** — `/export/download` saves the same page as a file.

## Data

Persisted to `data.json` in the project directory. Delete the file to wipe state, or use the **Reset All Data** button in the Results tab.

## Accuracy note

Race times use server clock for both start and finish, so a finish tap incurs the network round-trip from the phone to the server (typically tens to a few hundred milliseconds on cell). For kids' meets that is well within acceptable tolerance; for sanctioned timing use a dedicated system.
