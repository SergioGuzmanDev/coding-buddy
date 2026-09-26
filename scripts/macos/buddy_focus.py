#!/usr/bin/env python3
"""iTerm2 AutoLaunch script: writes the focused session id to ~/.claude-buddy/focused-session for animate: "focused".
Install by copying it to ~/Library/Application Support/iTerm2/Scripts/AutoLaunch/."""
import os

import iterm2

FOCUS_FILE = os.path.expanduser("~/.claude-buddy/focused-session")


def remember(session_id):
    tmp = FOCUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(session_id)
    os.replace(tmp, FOCUS_FILE)


async def focused_session_id(connection):
    app = await iterm2.async_get_app(connection)
    await app.async_refresh_focus()
    window = app.current_terminal_window
    tab = window.current_tab if window else None
    session = tab.current_session if tab else None
    return session.session_id if session else None


async def main(connection):
    # The monitor opens before the first read so a focus change in between is not lost.
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            session_id = await focused_session_id(connection)
            if session_id:
                remember(session_id)
            await monitor.async_get_next_update()


iterm2.run_forever(main)
