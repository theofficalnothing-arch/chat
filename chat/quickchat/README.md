# Quick Chat

A small chat you can host anywhere Node.js runs. There are no accounts and no passwords:
you type a name, and you are in. Names are only labels, so several people can use the same one.
Messages are saved on the server and appear live for everyone. No dependencies to install.

## Run it on your computer

    node server.js

Open http://localhost:3000, type a name, and start writing.
To let someone else on your Wi-Fi join, give them http://YOUR-COMPUTER-IP:3000.

## Put it on the internet

Any host that runs Node.js or Docker works. Two things matter:

1. **Persistent storage.** Everything is saved in one file, `DATA_DIR/db.json`.
   Mount a disk or volume there, or messages vanish on every redeploy.
2. **One instance.** Run a single copy of the server. The file is not shared between copies.

### Render (simple)
1. Push this folder to a GitHub repository.
2. New Web Service, pick the repo. Build command: leave empty. Start command: `node server.js`.
3. Add a Disk (paid plan), mount path `/data`, and set the environment variable `DATA_DIR=/data`.
4. Set `INVITE_CODE` (below), then deploy. Render gives you an https address.

### Railway or Fly.io
Both detect the Dockerfile. Attach a volume at `/data` and keep `DATA_DIR=/data` (already set in the Dockerfile).
On Fly: `fly launch`, `fly volumes create data --size 1`, add a `[mounts]` section with `source = "data"` and `destination = "/data"`.

### Your own server
    PORT=3000 DATA_DIR=/var/lib/quickchat INVITE_CODE=pick-a-code node server.js
Put it behind a reverse proxy that provides https (Caddy or nginx). Turn off response buffering for `/api/stream`.

## Settings (environment variables)

| Name | What it does | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | 3000 |
| `DATA_DIR` | Folder for `db.json` | `./data` |
| `INVITE_CODE` | If set, people must enter this room code to join | none (anyone with the link can join) |
| `OWNER_CODE` | Code that gives the Owner role (blue name, can post in #links) | `gg` |
| `JL_CODE` | Code that gives the "im just like that" role (red name) | `gh` |

**Set an `INVITE_CODE` on a public site.** Without it, anyone who finds the address can join and post.

## Channels and roles

The chat looks like Discord and has two channels. **#general** is a normal chat. **#links** is read-only for most people:
anyone can read it, but only Owners can post. Everyone else sees "You do not have permission to send messages in this channel."
Text in #links is shown in big letters, and any `https://` link is blue and opens in a new tab (this works in #general too).

Click **gg** in the bottom-left corner to open the code box:
- Type `gg` to become an **Owner**: your name turns blue and you can post in #links.
- Type `gh` to get the **im just like that** role: your name turns red.

Roles stick to that browser's identity, and everyone sees the colors live. Click your name in the bottom-left to change it.

**Change the codes before you put this on the internet.** Set `OWNER_CODE` and `JL_CODE`. The defaults are two letters long,
so anyone who guesses them can become an Owner. Codes can be entered 10 times per 10 minutes per person.

## How identity works (read this)

- When someone joins, their browser receives a private random ID (a cookie that lasts a year). That ID, not the name, is what
  owns their messages, so they can delete their own and nobody else's.
- The name is saved in that browser, so on the same device you stay "you" without doing anything.
- **A different computer, phone or browser counts as a new person.** You type your name again, and the older messages from
  your other device stay under that device's identity. Clearing cookies has the same effect.
- Because names are not unique and there is no password, anyone can pick someone else's name. Use the room code to keep
  strangers out, and only share the link with people you trust.

## Notes
- The last 5,000 messages are kept; older ones are dropped.
- Joining is limited to 20 tries per 10 minutes per address, and messages to 30 per minute per person.
