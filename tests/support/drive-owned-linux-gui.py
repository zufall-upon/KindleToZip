"""正規AT-SPIで、この起動に属する専用windowだけを操作する。"""
import ast
import collections
import json
import re
import select
import subprocess
import sys
import time

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def proc_stat(pid):
    with open('/proc/%d/stat' % pid, encoding='utf-8') as stream:
        text = stream.read()
    fields = text[text.rfind(')') + 2:].split()
    return int(fields[1]), fields[19]


root_pid = int(sys.argv[1])
root_birth = proc_stat(root_pid)[1]
# Register the standard focus listener on the isolated accessibility bus before
# the browser window is constructed. Event payloads are deliberately ignored.
listener = Atspi.EventListener.new(lambda _event, *_args: None)
for event_type in ['object:state-changed', 'object:children-changed', 'object:property-change']:
    if not listener.register(event_type):
        raise RuntimeError('private_atspi_listener_failed')


def pump():
    context = GLib.MainContext.default()
    while context.pending():
        context.iteration(False)


def owned(pid):
    seen = set()
    while pid and pid not in seen:
        seen.add(pid)
        try:
            parent, birth = proc_stat(pid)
        except (OSError, ValueError, IndexError):
            return False
        if pid == root_pid:
            return birth == root_birth
        pid = parent
    return False


address = ast.literal_eval(subprocess.check_output([
    '/usr/bin/gdbus', 'call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus',
    '--method', 'org.a11y.Bus.GetAddress'], text=True, timeout=5))[0]
bus = Gio.DBusConnection.new_for_address_sync(address,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)


def call(ref, interface, method, args=None):
    return bus.call_sync(ref[0], ref[1], interface, method, args, None, Gio.DBusCallFlags.NONE, 1000, None).unpack()


def children(ref):
    return [tuple(value) for value in call(ref, 'org.a11y.atspi.Accessible', 'GetChildren')[0]]


def name(ref):
    return call(ref, 'org.freedesktop.DBus.Properties', 'Get',
                GLib.Variant('(ss)', ('org.a11y.atspi.Accessible', 'Name')))[0]


def role(ref):
    return call(ref, 'org.a11y.atspi.Accessible', 'GetRoleName')[0]


def owner_pid(ref):
    return call(('org.freedesktop.DBus', '/org/freedesktop/DBus'), 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', GLib.Variant('(s)', (ref[0],)))[0]


def candidates():
    result = []
    for app in children(('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root')):
        try:
            pid = owner_pid(app)
            if not owned(pid):
                continue
            # No window name or child of an unrelated app is ever read.
            for top in children(app):
                if owned(owner_pid(top)) and name(top).startswith('KindleToZip — 手順ガイド'):
                    result.append((pid, top))
        except GLib.Error:
            continue
    return result


deadline = time.monotonic() + 45
window = None
while time.monotonic() < deadline:
    pump()
    matches = candidates()
    if len(matches) > 1:
        raise RuntimeError('owned_window_ambiguous')
    if matches:
        window_pid, window = matches[0]
        break
    time.sleep(.15)
if window is None:
    raise RuntimeError('owned_window_missing')


def verify():
    matches = candidates()
    if matches != [(window_pid, window)] or not owned(window_pid):
        raise RuntimeError('owned_window_identity_changed')


def nodes():
    verify()
    pending, result, seen = [window], [], set()
    deadline = time.monotonic() + 15
    while pending:
        ref = pending.pop()
        if ref in seen:
            continue
        seen.add(ref)
        if len(seen) > 2500 or time.monotonic() > deadline:
            raise RuntimeError('owned_tree_limit')
        try:
            if not owned(owner_pid(ref)):
                raise RuntimeError('foreign_child_refused')
            if ref[1] == '/org/a11y/atspi/null':
                continue
            result.append((ref, role(ref), name(ref)))
            pending.extend(reversed(children(ref)))
        except GLib.Error as error:
            raise RuntimeError('owned_accessibility_call_failed') from error
    return result


try:
    emit({'event': 'ready', 'windowPid': window_pid})
    if len(sys.argv) > 2 and sys.argv[2] == '--numeric-probe':
        for wanted in ['比較テキスト', '今回の最大取得画面数']:
            matches = [(ref, r) for ref, r, n in nodes() if n == wanted and r in ('entry', 'spin button')]
            if len(matches) != 1:
                raise RuntimeError('numeric_probe_target:' + repr(matches))
            ref, r = matches[0]
            emit({'event': 'numeric-probe-contract', 'role': r, 'interfaces': call(ref, 'org.a11y.atspi.Accessible', 'GetInterfaces'), 'state': call(ref, 'org.a11y.atspi.Accessible', 'GetState')})
            for operation in ['actions', 'value', 'value-int', 'value-string', 'text', 'focus', 'text', 'insert']:
                try:
                    if operation == 'actions':
                        result = call(ref, 'org.a11y.atspi.Action', 'GetActions')
                    elif operation.startswith('value'):
                        kind, value = ('i', 2) if operation == 'value-int' else ('s', '2') if operation == 'value-string' else ('d', 2.0)
                        result = call(ref, 'org.freedesktop.DBus.Properties', 'Set', GLib.Variant('(ssv)', ('org.a11y.atspi.Value', 'CurrentValue', GLib.Variant(kind, value))))
                    elif operation == 'focus':
                        result = call(ref, 'org.a11y.atspi.Component', 'GrabFocus')
                    elif operation == 'insert':
                        result = call(ref, 'org.a11y.atspi.EditableText', 'InsertText', GLib.Variant('(isi)', (0, '2', 1)))
                    else:
                        result = call(ref, 'org.a11y.atspi.EditableText', 'SetTextContents', GLib.Variant('(s)', ('2',)))
                    time.sleep(.2); pump()
                    emit({'event': 'numeric-probe-operation', 'role': r, 'operation': operation, 'result': result, 'state': call(ref, 'org.a11y.atspi.Accessible', 'GetState')})
                    try:
                        emit({'event': 'numeric-probe-readback', 'value': call(ref, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', ('org.a11y.atspi.Value', 'CurrentValue')))})
                    except GLib.Error:
                        pass
                except GLib.Error as error:
                    emit({'event': 'numeric-probe-error', 'role': r, 'operation': operation, 'error': str(error)})
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[2] == '--flow':
        def find(node_role, node_name):
            matches = [ref for ref, r, n in nodes() if r == node_role and n == node_name]
            if len(matches) != 1:
                raise RuntimeError('owned_control_missing_or_ambiguous:' + node_name)
            return matches[0]

        def find_action(node_name):
            matches = [ref for ref, r, n in nodes() if n == node_name and r in ('button', 'push button', 'toggle button')]
            if len(matches) != 1:
                raise RuntimeError('owned_action_missing_or_ambiguous:' + node_name)
            return matches[0]

        def click(ref):
            verify()
            if not call(ref, 'org.a11y.atspi.Action', 'DoAction', GLib.Variant('(i)', (0,)))[0]:
                raise RuntimeError('owned_action_failed')

        def wait_text(text, seconds=45):
            end = time.monotonic() + seconds
            last = []
            while time.monotonic() < end:
                pump()
                last = [n for _, r, n in nodes() if r in ('static', 'statusbar', 'alert') and n]
                if any(text in n for n in last):
                    return
                if any('browser_open_failed' in n for n in last):
                    raise RuntimeError('browser_open_failed')
                time.sleep(.2)
            raise RuntimeError('wait_failed:' + text + ':' + repr(last[:20]))

        def choose(label, expected=None):
            combo = find('combo box', label)
            click(combo)
            time.sleep(.6)
            menus = children(combo)
            if len(menus) != 1 or role(menus[0]) != 'menu':
                raise RuntimeError('owned_menu_invalid')
            items = children(menus[0])
            if len(items) != 2 or any(role(item) != 'menu item' for item in items):
                raise RuntimeError('owned_menu_options_invalid')
            emit({'event': 'options', 'label': label, 'names': [name(item) for item in items]})
            interfaces = call(menus[0], 'org.a11y.atspi.Accessible', 'GetInterfaces')[0]
            emit({'event': 'menu-interfaces', 'label': label, 'interfaces': interfaces})
            if expected is not None and name(items[1]) != expected:
                raise RuntimeError('owned_menu_option_unexpected')
            before = call(items[1], 'org.a11y.atspi.Accessible', 'GetState')
            emit({'event': 'option-before', 'label': label, 'state': before})
            # The Reader can already expose its sole candidate as the selected
            # value while still requiring explicit confirmation. Don't click an
            # already-selected option and accidentally clear the draft.
            if label == '対象の専用タブ' and before[0][0] & (1 << int(Atspi.StateType.SELECTED)):
                click(combo)
                emit({'event': 'preselected', 'label': label})
                return
            click(items[1])
            state = call(items[1], 'org.a11y.atspi.Accessible', 'GetState')
            emit({'event': 'option-state', 'label': label, 'state': state})
            time.sleep(.5)
            emit({'event': 'selected', 'label': label, 'nodes': [{'role': r, 'name': n} for _, r, n in nodes() if '対象の専用タブを選' in n or '選択した匿名の自作試料' in n]})

        def fill(node_role, label, value):
            ref = find(node_role, label)
            if node_role == 'spin button':
                end = time.monotonic() + 20
                needed = (1 << int(Atspi.StateType.ENABLED)) | (1 << int(Atspi.StateType.SENSITIVE))
                state = 0
                while time.monotonic() < end:
                    pump()
                    state = call(ref, 'org.a11y.atspi.Accessible', 'GetState')[0][0]
                    if state & needed == needed: break
                    time.sleep(.1)
                emit({'event': 'numeric-readiness', 'label': label, 'state': state})
                if state & needed != needed:
                    raise RuntimeError('owned_numeric_not_enabled:' + label)
                # Off-screen accessibles may be enabled but not showing and
                # cannot take focus. Scroll only this owned element into view.
                showing = 1 << int(Atspi.StateType.SHOWING)
                if not state & showing:
                    if not call(ref, 'org.a11y.atspi.Component', 'ScrollTo', GLib.Variant('(u)', (int(Atspi.ScrollType.ANYWHERE),)))[0]:
                        raise RuntimeError('owned_numeric_scroll_failed:' + label)
                    end = time.monotonic() + 3
                    while time.monotonic() < end:
                        pump()
                        state = call(ref, 'org.a11y.atspi.Accessible', 'GetState')[0][0]
                        if state & showing: break
                        time.sleep(.05)
                    emit({'event': 'numeric-scrolled', 'label': label, 'state': state})
                    if not state & showing:
                        raise RuntimeError('owned_numeric_not_showing:' + label)
                # The Value property setter is acknowledged but ignored by
                # this Chromium build in an unconfirmed state. Retry only after
                # the actual numeric field is enabled; then verify retention.
                call(ref, 'org.freedesktop.DBus.Properties', 'Set', GLib.Variant('(ssv)',
                     ('org.a11y.atspi.Value', 'CurrentValue', GLib.Variant('d', float(value)))))
                time.sleep(.3); pump()
                current = call(ref, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', ('org.a11y.atspi.Value', 'CurrentValue')))[0]
                if current != float(value):
                    # A number input may only expose editing once the exact
                    # owned element has received accessibility focus. No
                    # global keyboard or unrelated window is addressed.
                    if not call(ref, 'org.a11y.atspi.Component', 'GrabFocus')[0]:
                        raise RuntimeError('owned_numeric_focus_failed:' + label)
                    end = time.monotonic() + 3
                    while time.monotonic() < end:
                        pump()
                        state = call(ref, 'org.a11y.atspi.Accessible', 'GetState')[0][0]
                        if state & (1 << int(Atspi.StateType.FOCUSED)): break
                        time.sleep(.05)
                    if not state & (1 << int(Atspi.StateType.FOCUSED)):
                        raise RuntimeError('owned_numeric_focus_unconfirmed:' + label)
                    if not call(ref, 'org.a11y.atspi.EditableText', 'SetTextContents', GLib.Variant('(s)', (str(value),)))[0]:
                        raise RuntimeError('owned_numeric_text_edit_failed:' + label)
                    time.sleep(.3); pump()
                    current = call(ref, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', ('org.a11y.atspi.Value', 'CurrentValue')))[0]
                    if current != float(value):
                        raise RuntimeError('owned_numeric_edit_failed:' + label + ':' + repr(current))
            elif not call(ref, 'org.a11y.atspi.EditableText', 'SetTextContents', GLib.Variant('(s)', (str(value),)))[0]:
                raise RuntimeError('owned_text_edit_failed:' + label)

        def checkpoint(event):
            emit({'event': event})
            if not select.select([sys.stdin], [], [], 30)[0]:
                raise RuntimeError('checkpoint_timeout:' + event)
            value = json.loads(sys.stdin.readline())
            if value.get('continue') is not True:
                raise RuntimeError('checkpoint_refused:' + event)
            return value

        wait_text('新しい1冊の作業を用意')
        click(find('button', '決定・次へ'))
        wait_text('完了：作業を用意')
        time.sleep(.5)
        choose('取得元', '匿名の自作試料（新しい専用領域）')
        wait_text('選択した匿名の自作試料を開きます')
        click(find('button', '決定・次へ'))
        wait_text('対象タブ選択待ち', 70)
        wait_text('完了：専用ブラウザを準備', 30)
        time.sleep(.5)
        choose('対象の専用タブ')
        wait_text('対象の専用タブを選び、「決定・次へ」で確定してください')
        click(find('button', '決定・次へ'))
        wait_text('対象タブ選択済み・表示検査待ち')
        click(find('button', '決定・次へ'))
        wait_text('プレビュー確認待ち', 60)
        fill('spin button', '今回の最大取得画面数', 2)
        click(find('check box', 'この本・領域・次へ方向・位置が正しい'))
        wait_text('取得はまだ始まりません')
        click(find('button', '決定・次へ'))
        wait_text('承認済み・明示開始待ち')
        checkpoint('approved')
        click(find('button', '決定・次へ'))
        wait_text('画像点検', 60)
        wait_text('確定 2枚', 30)
        fixture = checkpoint('stopped')
        first, second = fixture['ids']
        click(find_action('画像番号を指定して順序・採用を変更'))
        fill('entry', '画像番号をカンマ区切り（省いた画像は除外・原本保持）', '%d,%d' % (second, first))
        click(find_action('順序・採用を保存'))
        checkpoint('ordered')
        for label, value in [('画像ID', first), ('x', 1), ('y', 1), ('幅', fixture['cropWidth']), ('高さ', fixture['cropHeight'])]:
            fill('spin button', label, value)
        click(find_action('クロップして結果を点検（原本保持）'))
        checkpoint('cropped')
        click(find_action('決定・次へ'))
        time.sleep(.5)
        fill('entry', '保存先のファイル名', fixture['zip'])
        click(find_action('決定・次へ'))
        checkpoint('zip')
        click(find_action('範囲確認・点検済みの印（任意）'))
        choose('別形式（必要な場合のみ）', 'CBZ（任意）')
        fill('entry', '保存先のファイル名', fixture['cbz'])
        click(find_action('決定・次へ'))
        checkpoint('cbz')
        fill('entry', '保存先のファイル名', fixture['collision'])
        click(find_action('決定・次へ'))
        wait_text('出力先に既存ファイルがあります')
        checkpoint('collision')
        emit({'event': 'flow-archive-complete'})
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[2] == '--inspect-create':
        button = next(ref for ref, node_role, node_name in nodes() if node_role in ('button', 'push button') and node_name == '決定・次へ')
        emit({'event': 'actions', 'value': call(button, 'org.a11y.atspi.Action', 'GetActions')})
        emit({'event': 'clicked', 'value': call(button, 'org.a11y.atspi.Action', 'DoAction', GLib.Variant('(i)', (0,)))})
        time.sleep(2)
        pump()
        emit({'event': 'after-create', 'nodes': [{'role': r, 'name': n} for _, r, n in nodes() if r in ('button', 'push button', 'combo box', 'menu item', 'entry', 'check box', 'spin button', 'statusbar') or '匿名' in n or '取得元' in n]})
        sys.exit(0)
    if len(sys.argv) > 2 and sys.argv[2] == '--inspect-open':
        def find(r, n):
            return next(ref for ref, node_role, node_name in nodes() if node_role == r and node_name == n)
        def click(ref):
            return call(ref, 'org.a11y.atspi.Action', 'DoAction', GLib.Variant('(i)', (0,)))
        click(find('button', '決定・次へ'))
        time.sleep(2)
        combo = find('combo box', '取得元')
        emit({'event': 'combo-actions', 'value': call(combo, 'org.a11y.atspi.Action', 'GetActions')})
        emit({'event': 'combo-open', 'value': click(combo)})
        time.sleep(.5)
        option = find('menu item', '匿名の自作試料（新しい専用領域）')
        emit({'event': 'option-actions', 'value': call(option, 'org.a11y.atspi.Action', 'GetActions')})
        emit({'event': 'option', 'value': click(option)})
        time.sleep(1)
        emit({'event': 'after-option', 'nodes': [{'role': r, 'name': n} for _, r, n in nodes() if '取得元' in n or '匿名' in n or '決定・次へ' in n]})
        emit({'event': 'open-click', 'value': click(find('button', '決定・次へ'))})
        until = time.monotonic() + 55
        while time.monotonic() < until:
            pump()
            text = [n for _, _, n in nodes()]
            if any('対象タブ選択待ち' in n or 'browser_open_failed' in n for n in text):
                break
            time.sleep(.2)
        emit({'event': 'after-open', 'nodes': [{'role': r, 'name': n} for _, r, n in nodes() if n and r in ('static', 'statusbar', 'alert')]})
        sys.exit(0)
    wanted = re.compile('決定・次へ|作業先|作業先・中断|取得元|今回の最大|プレビューを見て|この本・領域|対象の専用タブ|保存先のファイル名|画像番号を指定|クロップ|点検・再開')
    ready_deadline = time.monotonic() + 12
    while True:
        pump()
        all_nodes = nodes()
        selected = [{'role': node_role, 'name': node_name} for _, node_role, node_name in all_nodes if wanted.search(node_name)]
        if selected or time.monotonic() >= ready_deadline:
            break
        time.sleep(.2)
    child_status = []
    for child in children(window)[:5]:
        item = {'sameBus': child[0] == window[0]}
        try:
            item['owned'] = owned(owner_pid(child))
            if item['owned']:
                item['path'] = child[1]
                item['role'] = role(child)
        except GLib.Error as error:
            item['error'] = str(error)
        child_status.append(item)
    emit({'event': 'probe', 'rootRole': role(window), 'rootChildren': len(children(window)),
          'childStatus': child_status, 'roles': dict(collections.Counter(node_role for _, node_role, _ in all_nodes)), 'nodes': selected})
except Exception as error:
    emit({'event': 'failed', 'reason': str(error)})
    sys.exit(1)
