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
    written = None
    focus_changed = True
    # The monitor opens before the first read so a focus change in between is not lost.
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            # A tab can close between the focus change and these reads; dying here would freeze every tab's buddy.
            try:
                session = await focused_session(connection)
                if session:
                    # The status line compares this file's mtime against its gates, so a poll rewrites it only
                    # when the focus moved without an update, as when the id written last was a closing tab.
                    if focus_changed or session.session_id != written:
                        remember(FOCUS_FILE, session.session_id)
                        written = session.session_id
                        focus_changed = False
                    current = await session.async_get_variable("autoName") or ""
                    if current != title:
                        remember(TITLE_FILE, current)
                        title = current
            except iterm2.RPCException:
                pass
            try:
                await asyncio.wait_for(monitor.async_get_next_update(), TITLE_POLL_SECONDS)
                focus_changed = True
            except asyncio.TimeoutError:
                pass


iterm2.run_forever(main)
