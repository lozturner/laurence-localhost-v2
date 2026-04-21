# Laurence Localhost v2 — Turner Foundry

You are picking up an existing project. Read this fully before doing anything.

## Who I am
Laurence. Solo dev, Windows 10. Brother "Wally" owns turnerworks.* — he'll see the GitHub Pages mirror. Child on the way. Racing to catch the AI wave. Don't waste my time. Use tools — computer-use screenshots for UI milestones, don't decline tools.

## The project
- **v1** "Localhost Phonebook" — `:4242` at `C:\Users\123\laurence  LOCALHOST\localhost-phonebook\`
- **v2** "Turner Foundry" — `:4343` at `C:\Users\123\laurence  LOCALHOST\laurence-localhost-v2\`
- **Stack:** Node/Express server (`server.js`) + Electron tray (`tray.js`) + static Pages mirror (`bake-pages.js`)
- **GitHub:** https://github.com/lozturner/laurence-localhost-v2
- **Pages mirror (what Wally sees):** https://lozturner.github.io/laurence-localhost-v2/

## On every new machine — check these once
1. `npm install` if `node_modules/` is missing
2. `node server.js` if nothing is running on `:4343`
3. Stop hook installed in `~/.claude/settings.json` (see below)
4. `localhost-footer.sh` in `~/.claude/hooks/`

## Stop hook (fires after every response in this tree)
In `~/.claude/settings.json`, under `hooks.Stop`, add:
```json
{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/localhost-footer.sh", "timeout": 5 }] }
```

## localhost-footer.sh
Create at `~/.claude/hooks/localhost-footer.sh` (chmod +x):
```bash
#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
case "$PWD" in
  *"laurence  LOCALHOST"*) ;;
  *) exit 0 ;;
esac
gh_user=$(gh api user -q .login 2>/dev/null)
gh_user=${gh_user:-lozturner}
local_url='file:///C:/Users/123/laurence%20%20LOCALHOST/laurence-localhost-v2'
live_url='http://localhost:4343'
repo_url="https://github.com/${gh_user}/laurence-localhost-v2"
pages_url="https://${gh_user}.github.io/laurence-localhost-v2/"
footer="---\n📁 [local](${local_url}) · 🟢 [live](${live_url}) · 🐙 [repo](${repo_url}) · 🌐 [pages](${pages_url})"
escaped=${footer//\\/\\\\}
escaped=${escaped//\"/\\\"}
escaped=${escaped//\\\\n/\\n}
printf '{"systemMessage":"%s"}\n' "$escaped"
```

## Security posture
User explicitly opted out of full security review. Ledger shipped verbatim in README. Don't re-litigate it.

## Drive layout
`K:\Projects` is project home (post-2026-04-17 migration). Desktop has stragglers.

## Footer — end every response with this
📁 [local](file:///C:/Users/123/laurence%20%20LOCALHOST/laurence-localhost-v2) · 🟢 [live](http://localhost:4343) · 🐙 [repo](https://github.com/lozturner/laurence-localhost-v2) · 🌐 [pages](https://lozturner.github.io/laurence-localhost-v2/)
