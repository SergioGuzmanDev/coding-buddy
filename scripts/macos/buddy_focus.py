#!/usr/bin/env python3
"""iTerm2 AutoLaunch script: writes the focused session id to ~/.claude-buddy/focused-session for animate: "focused".
Install by copying it to ~/Library/Application Support/iTerm2/Scripts/AutoLaunch/."""
import asyncio
import os

import iterm2

FOCUS_FILE = os.path.expanduser("~/.claude-buddy/focused-session")
# A background session has no ITERM_SESSION_ID, so the status line finds its tab by this title instead.
TITLE_FILE = os.path.expanduser("~/.claude-buddy/focused-title")
# A fork replaces the tab's title without moving focus, so the title is also re-read on this period.
TITLE_POLL_SECONDS = 2


def remember(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


async def focused_session(connection):
    app = await iterm2.async_get_app(connection)
    await app.async_refresh_focus()
    window = app.current_terminal_window
    tab = window.current_tab if window else None
    return tab.current_session if tab else None


async def main(connection):
    title = None
    focus_changed = True
    # The monitor opens before the first read so a focus change in between is not lost.
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            session = await focused_session(connection)
            if session:
                # The status line compares this file's mtime against its gates, so only a focus change rewrites it.
                if focus_changed:
                    remember(FOCUS_FILE, session.session_id)
                current = await session.async_get_variable("autoName") or ""
                if current != title:
                    remember(TITLE_FILE, current)
                    title = current
            try:
                await asyncio.wait_for(monitor.async_get_next_update(), TITLE_POLL_SECONDS)
                focus_changed = True
            except asyncio.TimeoutError:
                focus_changed = False


iterm2.run_forever(main)
