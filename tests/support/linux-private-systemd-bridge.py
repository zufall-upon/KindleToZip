"""Forward only this test's Snap scope request, keeping its a11y bus private."""
import os
import re
import sys
import gi
from gi.repository import Gio, GLib

root = int(sys.argv[1])
host_address = os.environ['KTZ_OUTSIDE_SESSION_BUS']
if host_address == os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
    raise RuntimeError('private_session_required')


def identity(pid):
    with open('/proc/%d/stat' % pid, encoding='utf-8') as stream:
        text = stream.read()
    fields = text[text.rfind(')') + 2:].split()
    return int(fields[1]), fields[19]


birth = identity(root)[1]


def owned(pid):
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        try:
            parent, current = identity(pid)
        except (OSError, ValueError, IndexError):
            return False
        if pid == root:
            return current == birth
        pid = parent
    return False


flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
private = Gio.bus_get_sync(Gio.BusType.SESSION, None)
host = Gio.DBusConnection.new_for_address_sync(host_address, flags, None, None)
xml = '''<node><interface name="org.freedesktop.systemd1.Manager">
  <method name="StartTransientUnit"><arg type="s" direction="in"/><arg type="s" direction="in"/>
  <arg type="a(sv)" direction="in"/><arg type="a(sa(sv))" direction="in"/>
  <arg type="o" direction="out"/></method></interface></node>'''
interface = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
allowed_units = set()


def relay_job(_connection, _sender, _path, _interface, _signal, parameters, _data):
    if parameters.unpack()[2] in allowed_units:
        private.emit_signal(None, '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'JobRemoved', parameters)


host.signal_subscribe('org.freedesktop.systemd1', 'org.freedesktop.systemd1.Manager', 'JobRemoved',
                      '/org/freedesktop/systemd1', None, Gio.DBusSignalFlags.NONE, relay_job, None)


def dispatch(connection, sender, _path, _interface, method, parameters, invocation):
    try:
        if method != 'StartTransientUnit':
            raise RuntimeError('unsupported_method')
        unit, mode, properties, auxiliary = parameters.unpack()
        caller = connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                                      'GetConnectionUnixProcessID', GLib.Variant('(s)', (sender,)), None,
                                      Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
        checks = (bool(re.fullmatch(r'snap\.chromium\.chromium-[0-9a-f-]{36}\.scope', unit)), mode == 'fail',
                  properties == [('PIDs', [caller])], not auxiliary, owned(caller),
                  os.readlink('/proc/%d/exe' % caller) == os.path.realpath('/usr/bin/snap'))
        if not all(checks):
            raise RuntimeError('scope_request_refused:' + repr(checks))
        allowed_units.add(unit)
        reply = host.call_sync('org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                               'org.freedesktop.systemd1.Manager', method, parameters, None,
                               Gio.DBusCallFlags.NONE, 10000, None)
        invocation.return_value(reply)
        print('KTZ_SCOPE_REQUEST_FORWARDED', flush=True)
    except Exception as error:
        print('KTZ_SCOPE_REQUEST_REFUSED ' + type(error).__name__ + ': ' + str(error), file=sys.stderr, flush=True)
        invocation.return_dbus_error('org.kindletozip.TestBridge.Refused', 'scope request failed')


private.register_object('/org/freedesktop/systemd1', interface, dispatch, None, None)
answer = private.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                           'RequestName', GLib.Variant('(su)', ('org.freedesktop.systemd1', 4)), None,
                           Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
if answer != 1:
    raise RuntimeError('scope_bridge_name_unavailable')
print('KTZ_SCOPE_BRIDGE_READY', flush=True)
GLib.MainLoop().run()
