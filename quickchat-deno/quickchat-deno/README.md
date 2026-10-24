# Quick Chat (Deno version)

Discord-style chat for **Deno / Deno Deploy**. Everything is saved in **Deno KV**, a database that stays on after the
app sleeps, restarts or is redeployed. That fixes the "everything is gone after a while" problem: the older Node
version kept data in a file and in memory, and Deno Deploy throws both away when it stops an idle app.

## What it does
- Channels **#general**, **#links** (owners only post; big text; `https://` links are blue and open in a new tab) and **#suggestions** (anyone posts; owners can clear them).
- Join as a guest with just a name (names can repeat) or make an account (any password length, even one letter).
- Code button **gg**: `gg` = Owner (blue), `gh` = "im just like that" (red). Roles can change their name color and label text.
- Direct messages. Owners can read every DM.
- Owner backup and restore to move the chat to another site.

## Put it on Deno Deploy
1. Put this folder in a GitHub repo and connect it to a Deno Deploy app (or use `deployctl deploy`).
2. Entry point: `src/server.js`. No build step is needed (`src/assets.js` is already included).
3. Make sure the app has a **KV database** (Deno Deploy's docs explain how to attach one; some setups give you one automatically).
   Without a database, `Deno.openKv()` has nothing durable to write to.
4. In the app's settings add environment variables (at least `OWNER_CODE`).

## Run it on your computer
    deno task start        # then open http://localhost:8000
Data goes to a local KV file. Set `KV_PATH=./chat.db` to choose where.

## Settings (environment variables)
| Name | What it does | Default |
| --- | --- | --- |
| `OWNER_CODE` | Code for the Owner role. **Change it**: anyone with the Owner role can read every DM. | `gg` |
| `JL_CODE` | Code for the "im just like that" role | `gh` |
| `ADMIN_KEY` | Secret an Owner needs to download or restore a backup. Unset = backups off | none |
| `INVITE_CODE` | If set, people need this room code to join | none |
| `KV_PATH` | Local KV file path (not used on Deno Deploy) | default |
| `PORT` | Port for local runs | 8000 |

## Moving to another site
Settings (click your name) > Backup: type `ADMIN_KEY`, download, then restore on the new site. Accounts come across; guests do not
(a guest is only a cookie in one browser). Restoring signs everyone out. Backups from the older Node version cannot be restored here
because passwords are hashed differently.

## Changing the page
Edit `public/`, then run `deno task build` (rewrites `src/assets.js`).

## Tests
`node test/run.mjs` runs 12 checks (accounts, roles, channels, suggestions, DMs, deletes, live updates, backup, restart)
against a small stand-in for Deno KV, because real Deno was not available where this was written.
