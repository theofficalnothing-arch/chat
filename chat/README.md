# Quick Chat

A small Discord-style chat you can host anywhere Node.js runs. No dependencies to install.

- **#general** and **#links** channels (only Owners can post in #links; text there is big and `https://` links are clickable).
- **Direct messages** between people. Owners can read every DM, and the app says so on screen.
- **Guest or account.** Join with just a name, or make a username and password (any length, even one letter) so your
  name, role and messages follow you to any device.
- **Roles by code.** `gg` makes you an **Owner**, `gh` gives you the **im just like that** role. People with a role can
  change their name color and the text of their role label to anything.
- **Saves everything** to a file on the server, and Owners can download a backup and restore it on another website.

## Run it on your computer

    node server.js

Open http://localhost:3000. To let someone on your Wi-Fi join, give them http://YOUR-COMPUTER-IP:3000.

## Will it save? (read this before you host it)

Everything lives in one file, `DATA_DIR/db.json`. The server writes it after every change, keeps the previous copy as
`db.json.prev`, and saves a daily snapshot (last 7 days) in `DATA_DIR/backups/`. If the main file is damaged it starts from the
newest copy that still reads.

That only helps if the **disk survives**. Two cases:

- **Same website, restarted or redeployed:** your data is still there, as long as the host keeps the disk (see the table below).
  Many free hosts do not, and then everything is wiped on every restart.
- **A different website:** a new site is a new server with an empty file. Move your data with a backup (below).
  Accounts (username + password) come across and work on the new site. **Guests do not**, because a guest is only
  a cookie in one browser on one website. Their old messages stay, but nobody can sign in as that guest again.
  Tell guests to use *Settings → Save account* before you move.

### Moving to another website, or backing up
1. On the server, set `ADMIN_KEY` to a long secret (without it, backups are turned off).
2. Sign in as an Owner, open **Settings** (click your name, bottom left), type the admin key, press **Download backup**.
3. On the new site, set the same kind of `ADMIN_KEY`, become an Owner (`gg`), open Settings, choose the file, press
   **Restore from file** twice. Everyone with an account signs in as before.

The backup file contains password hashes. Keep it private.

## Free places to host it

I checked these in October 2026 against each company's own pages where I could, and a comparison site for the rest.
Free plans change often, so confirm on the site before you rely on one.

| Host | Runs this server? | Does the data survive? |
| --- | --- | --- |
| **Oracle Cloud "Always Free"** | Yes. A real virtual machine you control. Oracle lists up to 2 small AMD VMs plus Arm VMs, and 200 GB of disk. | **Yes.** The disk is permanent. Best fit if you want it to save. Setup is more work (you install Node and keep it running). |
| **Render** (free web service) | Yes, from GitHub or the Dockerfile. | **No.** Render says files are lost on every restart, redeploy or sleep, and free services have no disks. It also sleeps after 15 minutes without traffic and takes about a minute to wake. Works for trying it out, or with a backup you restore each time. |
| **Railway** | Yes, but the free part is a one-time $5 trial credit for 30 days, then about $1 a month of credit. | A small volume is listed for the free plan (0.5 GB), per a comparison site. |
| **Google Cloud Run** | Yes (containers), with a monthly free allowance. Scales to zero. | Not by default. Its storage is not kept between runs, so it would need extra setup. I did not confirm details. |
| **Koyeb** | Unclear. Koyeb's own FAQ describes one free web service; a comparison site says new accounts have had no free compute since February 2026. | Not confirmed. Check their site. |
| **Fly.io** | Not free for new accounts, only a short trial. | n/a |
| **Vercel, Netlify, Cloudflare Pages, GitHub Pages** | **No.** They host static files or short serverless functions. This chat needs a server that stays running and a place to store messages. | n/a |
| **jsDelivr** | **No.** It is a CDN for files, not a place to run a server. | n/a |

## Put it on the internet

1. Push this folder to GitHub (or use the Dockerfile).
2. Start command: `node server.js`. Port comes from `PORT`.
3. Mount a persistent disk at some folder and set `DATA_DIR` to it (the Dockerfile uses `/data`).
4. Run **one** copy only. The file is not shared between copies.
5. Use https (hosts like Render and Fly give you this). The server sets secure cookies when it sees https.

## Settings (environment variables)

| Name | What it does | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | 3000 |
| `DATA_DIR` | Folder for `db.json` and backups | `./data` |
| `INVITE_CODE` | If set, people must enter this room code to join or create an account | none |
| `OWNER_CODE` | Code that gives the Owner role | `gg` |
| `JL_CODE` | Code that gives the "im just like that" role | `gh` |
| `ADMIN_KEY` | Secret needed (with the Owner role) to download or restore backups. Unset = backups off | none |

**Before you put this on the internet, change `OWNER_CODE`.** Owners can read every direct message and post in #links. With the default `gg`, anyone who guesses it becomes an Owner and can read all DMs.
The server prints a warning at start while the default is in use.

## Safety notes

- Passwords are stored as salted scrypt hashes. Sign-in is limited to 10 tries per username and 20 per address every 10 minutes.
- **A one-letter password is easy to guess.** The limits slow people down but do not stop a patient attacker. For anyone
  with a role, especially Owners, a longer password is strongly advised.
- Cookies are HttpOnly and SameSite. Requests from other websites are refused. Pages are served with a strict content
  policy (scripts and styles only from this server), and all text is shown as plain text, so messages cannot run code.
- Links in messages only open if they start with `http://` or `https://`, in a new tab, without sharing the opener.
- Requests are size-limited. Messages can be 2000 characters. The last 5,000 channel messages and 20,000 DMs are kept.
- Rate limits use the address added by your hosting proxy. If you run it directly on the internet with no proxy,
  a determined person could spoof it, so put it behind your host's proxy.
