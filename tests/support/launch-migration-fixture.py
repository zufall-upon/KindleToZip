"""GIO launch/wait for an anonymous migration fixture, never the real shortcut."""
import os
import sys
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

entry = os.path.realpath(sys.argv[1])
if not entry.startswith('/home/user/KTZ-Migration-Tests/') or os.path.islink(sys.argv[1]):
    raise RuntimeError('not_anonymous_migration_fixture')
app = Gio.DesktopAppInfo.new_from_filename(entry)
if not app:
    raise RuntimeError('fixture_desktop_invalid')
pids = []
def launched(_info, pid, _data):
    pids.append(pid)
if not app.launch_uris_as_manager([], Gio.AppLaunchContext(), GLib.SpawnFlags.DO_NOT_REAP_CHILD,
        None, None, launched, None) or len(pids) != 1:
    raise RuntimeError('fixture_desktop_launch_failed')
_, status = os.waitpid(pids[0], 0)
if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
    raise RuntimeError('fixture_desktop_exit_failed')
