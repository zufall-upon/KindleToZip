"""既存の正規AT-SPIだけで当方要求のchooserを操作する。画像・キー・clipboardは使わない。"""
import ast
import collections
import json
import os
import select
import subprocess
import sys
import time

import gi
from gi.repository import Gio, GLib


class Refused(Exception):
    pass


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def receive():
    if not select.select([sys.stdin], [], [], 30)[0]:
        raise Refused('native_parent_timeout')
    return json.loads(sys.stdin.readline())


observation = {'actionPerformed': False, 'disappeared': False}
try:
    address = ast.literal_eval(subprocess.check_output([
        'gdbus', 'call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus',
        '--method', 'org.a11y.Bus.GetAddress'], text=True, timeout=5))[0]
    bus = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)

    def call(ref, interface, method, args=None):
        return bus.call_sync(ref[0], ref[1], interface, method, args, None, Gio.DBusCallFlags.NONE, 700, None).unpack()

    def children(ref):
        return [tuple(value) for value in call(ref, 'org.a11y.atspi.Accessible', 'GetChildren')[0]]

    def name(ref):
        return call(ref, 'org.freedesktop.DBus.Properties', 'Get',
                    GLib.Variant('(ss)', ('org.a11y.atspi.Accessible', 'Name')))[0]

    def tops():
        result = []
        for app in children(('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root')):
            try:
                result.extend(children(app))
            except GLib.Error:
                continue
        return result

    baseline = set(tops())
    emit({'event': 'ready'})
    request = receive()
    title, initial, chosen = request['title'], request['initial'], request['chosen']
    if not title.startswith('KindleToZip '):
        raise Refused('native_identity_invalid')
    if not os.path.isabs(initial) or not os.path.isabs(chosen):
        raise Refused('native_identity_invalid')
    status = open('/proc/' + str(request['pid']) + '/status', encoding='utf-8').read()
    if '\nPPid:\t' + str(request['parentPid']) + '\n' not in '\n' + status:
        raise Refused('native_child_not_owned')

    def matching():
        return [ref for ref in tops() if ref not in baseline and name(ref) == title]

    deadline = time.monotonic() + 12
    root = None
    while time.monotonic() < deadline:
        candidates = matching()
        if len(candidates) > 1:
            raise Refused('native_chooser_ambiguous')
        if len(candidates) == 1:
            root = candidates[0]
            break
        time.sleep(0.1)
    if root is None:
        raise Refused('native_chooser_missing')
    observation['appearedAfterStart'] = True
    host = call(('org.freedesktop.DBus', '/org/freedesktop/DBus'), 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', GLib.Variant('(s)', (root[0],)))[0]
    observation['hostIsZenityChild'] = host == request['pid']
    observation['title'] = title
    nodes, seen = [], set()
    deadline = time.monotonic() + 15

    def walk(ref, parent=None, depth=0):
        if ref in seen:
            return
        if depth == 50 or len(seen) == 3500 or time.monotonic() > deadline:
            raise Refused('native_structure_limit')
        seen.add(ref)
        role = call(ref, 'org.a11y.atspi.Accessible', 'GetRoleName')[0]
        interfaces = call(ref, 'org.a11y.atspi.Accessible', 'GetInterfaces')[0]
        nodes.append((ref, parent, role, name(ref), interfaces))
        for child in children(ref):
            walk(child, ref, depth + 1)

    walk(root)
    observation['roleCounts'] = dict(collections.Counter(node[2] for node in nodes))
    choosers = [node for node in nodes if node[2] == 'file chooser']
    if len(choosers) != 1:
        raise Refused('native_filechooser_role_missing')
    folder = os.path.dirname(initial)
    folder_seen = any(node[3] in (folder, os.path.basename(folder), 'file://' + folder) for node in nodes)
    fields = []
    for node in nodes:
        if 'org.a11y.atspi.EditableText' in node[4] and 'org.a11y.atspi.Text' in node[4]:
            text = call(node[0], 'org.a11y.atspi.Text', 'GetText', GLib.Variant('(ii)', (0, -1)))[0]
            if text in (initial, os.path.basename(initial)):
                fields.append(node)
                folder_seen = folder_seen or text == initial
    observation['anonymousInitialPathMatched'] = folder_seen and len(fields) == 1
    if not observation['anonymousInitialPathMatched']:
        raise Refused('native_initial_path_unverified')
    labels = (['保存', '保存(S)', 'Save', 'OK', 'OK(O)', '确定'] if request['action'] == 'select'
              else ['キャンセル', 'キャンセル(C)', 'Cancel', 'Cancel(C)', '取消'])
    buttons = [node for node in nodes if node[2] in ('button', 'push button') and node[3].replace('_', '') in labels]
    if len(buttons) != 1:
        raise Refused('native_action_ambiguous')

    def validate(node):
        if matching() != [root] or name(root) != title:
            raise Refused('native_identity_changed')
        if call(root, 'org.a11y.atspi.Accessible', 'GetRoleName')[0] != nodes[0][2]:
            raise Refused('native_identity_changed')
        if call(choosers[0][0], 'org.a11y.atspi.Accessible', 'GetRoleName')[0] != 'file chooser':
            raise Refused('native_identity_changed')
        root_state = call(root, 'org.a11y.atspi.Accessible', 'GetState')[0][0]
        if root_state & ((1 << 25) | (1 << 30)) != ((1 << 25) | (1 << 30)):
            raise Refused('native_target_not_showing')
        ref, parent, role, expected_name, _ = node
        if name(ref) != expected_name or call(ref, 'org.a11y.atspi.Accessible', 'GetRoleName')[0] != role:
            raise Refused('native_identity_changed')
        if parent is not None:
            actual_parent = call(ref, 'org.freedesktop.DBus.Properties', 'Get',
                                 GLib.Variant('(ss)', ('org.a11y.atspi.Accessible', 'Parent')))[0]
            if tuple(actual_parent) != parent or ref not in children(parent):
                raise Refused('native_identity_changed')
        state = call(ref, 'org.a11y.atspi.Accessible', 'GetState')[0][0]
        if state & ((1 << 25) | (1 << 30) | (1 << 8)) != ((1 << 25) | (1 << 30) | (1 << 8)):
            raise Refused('native_target_not_showing')

    if request['action'] == 'select':
        validate(fields[0])
        if not call(fields[0][0], 'org.a11y.atspi.EditableText', 'SetTextContents', GLib.Variant('(s)', (chosen,)))[0]:
            raise Refused('native_edit_failed')
        if call(fields[0][0], 'org.a11y.atspi.Text', 'GetText', GLib.Variant('(ii)', (0, -1)))[0] != chosen:
            raise Refused('native_edit_failed')
    validate(buttons[0])
    actions = call(buttons[0][0], 'org.a11y.atspi.Action', 'GetActions')[0]
    allowed = [index for index, action in enumerate(actions) if action[0].casefold() in ('click', 'press', 'activate')]
    if len(allowed) != 1:
        raise Refused('native_action_unavailable')
    if not call(buttons[0][0], 'org.a11y.atspi.Action', 'DoAction', GLib.Variant('(i)', (allowed[0],)))[0]:
        raise Refused('native_action_failed')
    observation['actionPerformed'] = True
    emit({'event': 'acted', **observation})
    if receive().get('event') != 'settled':
        raise Refused('native_parent_protocol')
    deadline = time.monotonic() + 5
    while root in tops() and time.monotonic() < deadline:
        time.sleep(0.1)
    observation['disappeared'] = root not in tops()
    if not observation['disappeared']:
        raise Refused('native_chooser_remains')
    emit({'event': 'finished', **observation})
except Exception as error:
    emit({'event': 'failed', 'code': str(error) if isinstance(error, Refused) else 'native_driver_failed', **observation})
    # 失敗後は操作しない。親による当方Zenity終了後の消失だけを観測する。
    if 'root' in locals() and root is not None:
        try:
            if receive().get('event') == 'settled':
                deadline = time.monotonic() + 5
                while root in tops() and time.monotonic() < deadline:
                    time.sleep(0.1)
                emit({'event': 'cleanup', 'disappeared': root not in tops()})
        except Exception:
            emit({'event': 'cleanup', 'disappeared': False})
    sys.exit(1)
