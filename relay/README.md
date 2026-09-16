# BG-ProMIDI live-share relay

A tiny WebSocket relay that lets the BG-ProMIDI page's **Live Share**
feature work: your machine (the "broadcaster", next to Pro Tools)
pushes small HTML snapshots of the counter to this relay, and anyone
you send a `?view=...` link to (the "viewer") gets them mirrored live
in their own browser. The relay never touches MIDI and does no HUI
decoding -- it only forwards already-rendered HTML between browsers,
so it's tiny and has nothing studio-specific in it.

This is meant to run **on your own Mac, always on**, reachable from
the internet through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
-- no router port-forwarding, no exposing your network, free.

## 1. Try it in the next 5 minutes (quick tunnel, URL changes each restart)

```sh
cd relay
npm install
npm start
```

Leave that running. In a second Terminal tab:

```sh
brew install cloudflared      # one-time
cloudflared tunnel --url http://localhost:8787
```

`cloudflared` prints a URL like `https://random-words-1234.trycloudflare.com`.
Your relay address for the app is that URL with `wss://` instead of
`https://` and `/ws` on the end, e.g.:

```
wss://random-words-1234.trycloudflare.com/ws
```

Paste that into BG-ProMIDI's **Live Share** field and click **Start
Sharing**. Copy the link it gives you and open it (or send it) --
that's the whole flow. This URL changes every time you restart
`cloudflared`, so it's for trying things out today, not for handing
out permanently.

## 2. Always-on setup (stable URL, survives reboots)

For a URL that never changes, Cloudflare Tunnel wants a domain added
to your Cloudflare account (the free plan is fine -- a cheap domain
from anywhere works, it doesn't need to be anything fancy, e.g.
`bgpromidi-relay.com` or a subdomain of a domain you already own).

```sh
cloudflared tunnel login                          # opens a browser, pick your domain
cloudflared tunnel create bgpromidi-relay
cloudflared tunnel route dns bgpromidi-relay relay.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: bgpromidi-relay
credentials-file: /Users/felipe/.cloudflared/<the-uuid-that-tunnel-create-printed>.json
ingress:
  - hostname: relay.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```

Then install both pieces as background services that start on login
and restart themselves if they crash or you reboot:

```sh
sudo cloudflared service install
```

For the relay itself, use the LaunchAgent in this folder
(`com.bgpromidi.relay.plist`) -- see the comment at the top of that
file for the one-line install command. Once both are running, your
permanent relay address is:

```
wss://relay.yourdomain.com/ws
```

Put that once into BG-ProMIDI's Live Share field -- it's saved in
your browser after that, so you only do this once per computer.

## Notes on security / who can watch

A share link is only as private as the session code in it (the
`?view=ABC123` part) -- anyone with the exact link can watch, same as
any other shareable link. There's no login. Don't post the link
somewhere public if you don't want randoms watching your session.
The relay keeps no history and no database -- it only remembers the
*last* snapshot per session, in memory, and forgets it the moment the
process restarts.

## Health check

`curl https://relay.yourdomain.com/health` (or the trycloudflare URL)
returns a small JSON blob with how many sessions/connections are
currently active -- useful for confirming it's alive without opening
the app.
