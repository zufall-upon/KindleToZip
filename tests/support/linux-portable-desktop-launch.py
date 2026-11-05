"""Launch exactly the delivered desktop entry using the standard GIO API."""
import os
import sys
import time
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

entry = '/home/user/デスクトップ/KindleToZip-Ubuntu-Portable.desktop'
app = Gio.DesktopAppInfo.new_from_filename(entry)
if not app:
    raise RuntimeError('desktop_entry_unavailable')
context = Gio.AppLaunchContext()
pids = []

def launched(_context, _info, details):
    pid = details.unpack().get('pid')
    if not isinstance(pid, int) or pid <= 0:
        raise RuntimeError('desktop_pid_unavailable')
    pids.append(pid)
    print('KTZ_DESKTOP_PID %d' % pid, flush=True)

context.connect('launched', launched)
managed = []
def managed_pid(_info, pid, _data):
    managed.append(pid)

# Standard GIO manager launch of the exact .desktop entry, with child reaping
# explicitly assigned to this observer so disappearance is not called exit 0.
if not app.launch_uris_as_manager([], context, GLib.SpawnFlags.DO_NOT_REAP_CHILD,
        None, None, managed_pid, None) or len(pids) != 1 or managed != pids:
    raise RuntimeError('desktop_launch_failed')
try:
    _, status = os.waitpid(pids[0], 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise RuntimeError('desktop_process_failed')
except ChildProcessError:
    raise RuntimeError('desktop_application_exit_status_unobserved')
