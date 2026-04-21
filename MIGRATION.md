# Drive Migration Log — 2026-04-17

## What happened

C: drive hit 0 bytes free (237.8 GB used on a 237.8 GB drive).
Emergency cleanup + project migration was performed.

---

## Phase 1 — C: drive cleanup (~12.3 GB freed)

Cleared temp/cache locations:
- `%TEMP%` (AppData\Local\Temp) — 1,586 MB
- `C:\Windows\Temp` — 9,034 MB
- `C:\Windows\SoftwareDistribution\Download` — 2 MB
- `C:\Windows\Prefetch` — 11 MB
- Chrome cache + code cache — 631 MB
- Edge cache + code cache — 739 MB
- pip cache — 2 MB
- CrashDumps — 376 MB
- INetCache — 45 MB
- Recycle Bin — 129 MB

---

## Phase 2 — Project migration

All Desktop project folders moved:

```
C:\Users\123\Desktop\<project>
    → D:\Projects\<project>   (staging)
    → K:\Projects\<project>   (final home)
```

### Final drive state (post-migration)

| Drive | Used    | Free    | Total   |
|-------|---------|---------|---------|
| C:    | 208 GB  | 29.8 GB | 237.8 GB |
| D:    | 188 GB  | 34.4 GB | 222.4 GB |
| K:    | 63 GB   | 175 GB  | 238.7 GB |

K: is now the working drive for projects (175 GB free).

---

## Where projects live now

| Location | Contents |
|---|---|
| `K:\Projects\` | All former Desktop project folders (188 items) |
| `C:\Users\123\Desktop\` | Shortcuts, .lnk files, ~10 folders still in-use at migration time |
| `C:\Users\123\laurence  LOCALHOST\` | The phonebook itself — NOT moved |
| `C:\Users\123\LLMStack\` | LLMStack — NOT moved (was never on Desktop) |
| `C:\Users\123\my-react-app\` | My React App — NOT moved |
| `C:\Users\123\.node-red\` | Node-RED — NOT moved |

### Desktop stragglers (couldn't move — were in-use at migration time)

These may or may not still be on `C:\Users\123\Desktop` depending on whether they've been closed since:
- `laurence bring` (worktree was open)
- `claude-v1` (running)
- `donner-pad` (running)
- `laurence and loz needs` (open)
- `Laurence Claude Statup items` (running)
- `Laurence Laurence` (in use)
- `laurence left word insert` (in use)
- `Laurence linking screenshot...` (in use)
- `laurence see ahead` (in use)
- `laurence wake word` (in use)
- `niggly_machine` (in use)

The phonebook scanner checks BOTH `K:\Projects` AND `C:\Users\123\Desktop` to catch all of these.

---

## Config files updated post-migration

### `K:\Projects\.claude\launch.json`
Updated all `C:\Users\123\Desktop\<project>` path references to `K:\Projects\<project>`.

### `localhost-phonebook/scanner.js`
- Added `K:\Projects` as a primary scan location (depth 1, isRoot=true)
- Kept `C:\Users\123\Desktop` scan for stragglers

---

## Key path map (before → after)

```
C:\Users\123\Desktop\ai-whack           → K:\Projects\ai-whack
C:\Users\123\Desktop\brain-sim          → K:\Projects\brain-sim
C:\Users\123\Desktop\super-canvas-app   → K:\Projects\super-canvas-app
C:\Users\123\Desktop\html-editor        → K:\Projects\html-editor
C:\Users\123\Desktop\org-sim            → K:\Projects\org-sim
C:\Users\123\Desktop\Laurence Watchers  → K:\Projects\Laurence Watchers
C:\Users\123\Desktop\laurence bring     → K:\Projects\laurence bring (+ possibly still on Desktop)
C:\Users\123\Desktop\wifi-sentinel      → K:\Projects\wifi-sentinel
C:\Users\123\Desktop\voice_commander    → K:\Projects\voice_commander
C:\Users\123\Desktop\wait-buddy         → K:\Projects\wait-buddy
C:\Users\123\Desktop\binman             → K:\Projects\binman
C:\Users\123\Desktop\sandra             → K:\Projects\sandra
C:\Users\123\Desktop\alexa-puck         → K:\Projects\alexa-puck
C:\Users\123\Desktop\laurence windows chatbot → K:\Projects\laurence windows chatbot
... (all other Desktop projects similarly)
```

---

## For future Claude sessions

If you're working on a project that "used to be on the Desktop", it's now at `K:\Projects\<name>`.

The phonebook at `http://localhost:4242` shows the current state of all projects
and their locations. Re-scan after any new project is created or moved.

The phonebook itself lives at:
`C:\Users\123\laurence  LOCALHOST\localhost-phonebook`

Auto-starts via:
`C:\Users\123\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\localhost-phonebook.vbs`
