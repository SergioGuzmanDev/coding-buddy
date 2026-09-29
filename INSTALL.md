# Installing this fork

A small companion that lives in the Claude Code status line and reacts to each turn with a speech bubble.
This is Sergio's fork of [ramarivera/coding-buddy](https://github.com/ramarivera/coding-buddy). It adds:

- Reactions written by their own model call after each turn, so your Claude session never spends a turn on them.
  Claude (Haiku) writes them by default. Gemini, through Google's Antigravity CLI (`agy`), is the option.
- 50 emotes the octopus acts out while it talks, and colors for how it feels. Only the octopus has them.
- On macOS with iTerm2: the bubble waits until you look at the tab, closes after 15 seconds, and cmd+click on
  the buddy's name reopens it.

## Install

Open Claude Code and paste this:

```
Install coding-buddy for me by following INSTALL.md from https://github.com/SergioGuzmanDev/coding-buddy
```

Claude asks you up to three questions and does the rest. The steps below are written for it.

## Steps for the installing agent

Run the steps in order. Ask the user only what step 2 asks. Do not use the plugin marketplace or the Quick Start in
`README.md`: they install the original project, without this fork's changes.

Your shell goes back to its starting folder after every command, so each command below starts with its own `cd`.
If you install `bun` in step 1, this shell does not have it on `PATH` yet: start every later command with
`export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH";`.

### 1. Prepare the machine

1. `git`: if it is missing on macOS, ask the user to run `xcode-select --install` and wait for it to finish.
2. `bun`: if it is missing, run `curl -fsSL https://bun.sh/install | bash`.
3. `jq`: if it is missing on macOS, run `brew install jq`. Without Homebrew, ask the user how they install packages.
4. `claude`: check `zsh -lic 'command -v claude'`. If it prints nothing, the Claude brain cannot start from the
   buddy's hooks. Tell the user in step 2, and recommend agy.
5. Run `claude plugin list`. If it lists `coding-buddy`, tell the user it would give them two buddies, and run
   `claude plugin uninstall coding-buddy@coding-buddy` once they agree.

### 2. Tell the user about the emotes, then ask

First tell the user, in their language:

> Sergio only gave emotes to the octopus: 50 moves it acts out while it talks, and colors for its mood. Any other
> species reacts with a speech bubble but does not move. You can ask Claude to add emotes to your species later.

Then ask these questions in one message:

1. **Which buddy, and what name?** The octopus (recommended: it is the only one with emotes), or the species their
   Claude account hatches (random, but always the same for their account). An octopus can take a name of their
   choice, or get a free one.
2. **Who writes the reactions?**
   - **Claude** (default): one short Haiku call after each turn, at most one every 30 seconds per session. It counts
     towards their Claude plan's usage. Nothing else to install.
   - **Gemini through agy**: free quota, but it needs Google's Antigravity CLI and a sign-in. For security, they
     should sign in with their company Google account, not a personal one: every reaction sends part of the
     conversation to Google.
3. Only if `$TERM_PROGRAM` is `iTerm.app`: **Do they want the iTerm2 extras?** The bubble waits until they look at
   the tab, closes after 15 seconds, and cmd+click on the buddy's name reopens it.

### 3. Install the buddy

Clone the repository, then install. The installer replaces the status line, so this command
keeps the one the user already had and runs it under the buddy (`subStatusCommand`).

```bash
git clone https://github.com/SergioGuzmanDev/coding-buddy ~/coding-buddy
cd ~/coding-buddy \
  && old=$(jq -r '.statusLine.command // empty' ~/.claude/settings.json 2>/dev/null || true) \
  && bun install && bun run install-buddy \
  && case "$old" in
       ""|*buddy-status.sh*) ;;
       *) bun -e 'import { saveConfig } from "./server/state.ts"; saveConfig(JSON.parse(process.argv[1]));' \
            "$(jq -nc --arg c "$old" '{subStatusCommand: $c, subStatusInline: true}')" ;;
     esac
```

The installer copies the clone to `~/.claude-buddy/app` and registers the MCP server, the `/buddy` skill, the hooks
and the status line. The buddy's settings live in `~/.claude-buddy/config.json`. The later steps change them with
this command, giving it the settings as JSON:

```bash
cd ~/coding-buddy && bun -e 'import { saveConfig } from "./server/state.ts"; saveConfig(JSON.parse(process.argv[1]));' '{"brain":"agy"}'
```

### 4. The octopus

If the user chose the octopus, run `cd ~/coding-buddy && bun run hunt --species octopus --name <Name>`. Leave out
`--name <Name>` for a free name. Tell the user its name.

### 5. The brain

For Claude there is nothing to do. For agy:

1. Run `curl -fsSL https://antigravity.google/cli/install.sh | bash`. It installs `agy` in `~/.local/bin`.
2. Check `zsh -lic 'command -v agy'`. If it prints nothing, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.
3. Ask the user to run `agy` in another terminal tab, sign in with their **company** Google account in the browser
   that opens, and quit it. You cannot do this sign-in for them.
4. Check it: `agy -p "Say ok" --output-format json --model gemini-3.8-flash-high </dev/null` must print JSON with a
   `response`.
5. Set `{"brain":"agy"}` with the settings command from step 3.

### 6. iTerm2 extras

Only if the user wants them:

1. Turn on iTerm2's Python API: `defaults write com.googlecode.iterm2 EnableAPIServer -bool true`.
2. Install the focus tracker:
   `mkdir -p ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch && cp ~/coding-buddy/scripts/macos/buddy_focus.py ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/`.
3. Install the cmd+click handler: `bash ~/coding-buddy/scripts/macos/install-click-toggle.sh`.
4. Set `{"animate":"focused","clickToExpand":true}` with the settings command from step 3.

### 7. Finish

1. Run `cd ~/coding-buddy && bun run doctor` and fix any ✗ it reports.
2. Tell the user to quit Claude Code, open a new terminal tab (so it has `bun` on `PATH`) and start Claude Code
   there. If they chose the iTerm2 extras, they quit and reopen iTerm2 instead, and accept if it offers to download
   its Python runtime.
3. Tell them to run `/buddy` to meet the buddy, and `/buddy help` for the commands.

## More emotes

Only the octopus has emotes. To give your species some, open Claude Code in the clone and ask it:

```
Add emotes to the <species>, like the octopus has in STATUS_MOVES in server/art.ts. Keep the tests in server/art.test.ts passing.
```

Then run `bun run install-buddy` so the buddy picks them up.

## Update and uninstall

- Update: `git pull && bun install && bun run install-buddy` in the clone.
- Uninstall: run `bun run uninstall` in the clone. It keeps `~/.claude-buddy`, so an earlier status line can come
  back from there, and it leaves the iTerm2 extras in place:
  1. Restore the old status line, if there was one:
     `c=$(jq -r '.subStatusCommand // empty' ~/.claude-buddy/config.json); [ -n "$c" ] && jq --arg c "$c" '.statusLine = {type: "command", command: $c}' ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json`
  2. Remove the iTerm2 extras: `rm -rf ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/buddy_focus.py ~/Applications/Coding\ Buddy\ Toggle.app`

## What leaves your machine

After each turn the brain receives your last message, Claude's last reply and some earlier turns of the
conversation, without tool output. `server/brain-react.ts` builds that prompt. With the Claude brain it goes to
Anthropic, like the rest of your session. With agy it goes to Google.
