#!/usr/bin/env python3
"""saymend-remote：讓遠端主機上的 saymend-voice mod 使用這台 Mac 的 Saymend 與喇叭。

同一個檔案有兩種身分：

Mac 端（橋接）
    saymend_remote.py connect <ssh 主機> [<ssh 主機>…]
        1. 在 Mac 上開一個 unix socket，只接受固定幾種請求：
           執行 `saymend` 的 status／dictate／stop／cancel／events，以及用 `say` 朗讀。
        2. 把這個檔案複製到遠端的 ~/.saymend-remote/，並建立 bin/saymend、bin/say 兩個 symlink。
        3. 用 `ssh -R` 把遠端的 ~/.saymend-remote/bridge.sock 接回 Mac 的 socket，斷線自動重連。
    saymend_remote.py uninstall <ssh 主機> [<ssh 主機>…]
        移除遠端的 ~/.saymend-remote/。

遠端（client）：被叫成 `saymend` 或 `say` 時（也就是上面那兩個 symlink）
    saymend …   參數原樣交給 Mac 上的 saymend CLI，stdout／stderr／結束碼原樣帶回。
    say [-v 語音] [文字]   文字交給 Mac 的 `say`；沒給文字就讀 stdin（與 macOS 的 `say` 相同）。

線上格式（unix socket，NDJSON，UTF-8）：
    請求（第一行）  {"v":1,"cmd":"saymend","args":[…]}　或　{"v":1,"cmd":"say","voice":"…","text":"…"}
    回覆（多行）    {"out":"…"}、{"err":"…"}，最後一行 {"exit":N}
    client 中途關閉連線＝取消：橋接會結束 Mac 上對應的行程（聽寫會被丟棄、麥克風關閉）。

只用 Python 標準函式庫，Mac 與遠端都需要 python3（3.8 以上）。
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

PROTOCOL = 1
REMOTE_DIR = '.saymend-remote'
SOCKET_NAME = 'bridge.sock'
SOCKET_ENV = 'SAYMEND_REMOTE_SOCKET'

#: 請求那一行的長度上限（位元組）
MAX_REQUEST_BYTES = 256 * 1024
#: 一次朗讀最多幾個字元，超過就截掉
MAX_SAY_CHARS = 8000

SUBCOMMANDS = ('status', 'dictate', 'stop', 'cancel', 'events', '--version')
#: 只有 dictate 收的、後面要帶數字的參數
DICTATE_VALUE_FLAGS = ('--max-seconds', '--silence-ms', '--no-speech-seconds')
NUMBER = re.compile(r'^\d+(\.\d+)?$')
#: `events --presence <tag>` 的 tag（mod 目前只用 loop）
PRESENCE_TAG = re.compile(r'^[a-z0-9_-]{1,32}$')
#: 系統語音名稱：字母、數字、空白與少數標點（例如「Meijia」「Samantha (Enhanced)」）
VOICE = re.compile(r'^[\w .()\-]{1,64}$')

UNREACHABLE = '連不上 Mac：saymend-remote 沒有在執行，或 SSH 連線中斷'
DROPPED = '與 Mac 的連線中斷'


# ── 共用 ──────────────────────────────────────────────────────────────────


def validate_saymend_args(args: object) -> str | None:
    """檢查要交給 saymend CLI 的參數；不接受就回傳原因。

    只放行 saymend-voice 會用到的子指令與參數，避免遠端能叫 Mac 做其他事。
    """
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        return 'args 必須是字串陣列'
    if not args or args[0] not in SUBCOMMANDS:
        return f'只接受這些子指令：{"、".join(SUBCOMMANDS)}'

    is_dictate = args[0] == 'dictate'
    is_events = args[0] == 'events'
    rest = args[1:]
    index = 0
    while index < len(rest):
        arg = rest[index]
        index += 1
        if arg == '--json':
            continue
        if is_dictate and arg == '--polish':
            continue
        name, has_value, value = arg.partition('=')
        if is_events and name == '--presence':
            if not has_value:
                if index >= len(rest):
                    return '--presence 後面要有 tag'
                value = rest[index]
                index += 1
            if PRESENCE_TAG.match(value) is None:
                return '--presence 的 tag 不合法'
            continue
        if is_dictate and name in DICTATE_VALUE_FLAGS:
            if not has_value:
                if index >= len(rest):
                    return f'{name} 後面要有數字'
                value = rest[index]
                index += 1
            if NUMBER.match(value) is None:
                return f'{name} 的值必須是數字'
            continue

        return f'不接受的參數：{arg}'

    return None


def send_frame(conn: socket.socket, frame: dict) -> bool:
    """送一行 NDJSON；對方已經離開就回 False。"""
    try:
        conn.sendall((json.dumps(frame, ensure_ascii=False) + '\n').encode('utf-8'))
    except OSError:
        return False

    return True


# ── 遠端：client ──────────────────────────────────────────────────────────


def default_socket_path() -> str:
    return os.environ.get(SOCKET_ENV) or str(Path.home() / REMOTE_DIR / SOCKET_NAME)


def exchange(request: dict) -> int | str:
    """把請求送給橋接，邊收邊印出 stdout／stderr。

    回傳 Mac 那邊的結束碼（int）；連不上或中途斷線則回傳原因（str）。
    """
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(default_socket_path())
    except OSError:
        conn.close()

        return UNREACHABLE

    try:
        if not send_frame(conn, request):
            return UNREACHABLE
        pending = b''
        while True:
            try:
                data = conn.recv(65536)
            except OSError:
                return DROPPED
            if not data:
                return DROPPED
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                if 'out' in frame:
                    sys.stdout.write(str(frame['out']))
                    sys.stdout.flush()
                elif 'err' in frame:
                    sys.stderr.write(str(frame['err']))
                    sys.stderr.flush()
                elif 'exit' in frame:
                    return int(frame['exit'])
    finally:
        conn.close()


def client_saymend(args: list[str]) -> int:
    """遠端的 `saymend`：行為照 saymend CLI 的輸出契約（v1）。"""
    outcome = exchange({'v': PROTOCOL, 'cmd': 'saymend', 'args': args})
    if isinstance(outcome, int):
        return outcome

    # 連不上 Mac：照契約回「app 未執行」（exit 3），另外用 code 區分是橋接的問題
    message = outcome
    sys.stderr.write(f'saymend: {message}\n')
    if '--json' in args:
        if args[:1] == ['status']:
            line = {'v': PROTOCOL, 'app': 'not_running', 'message': message}
        else:
            line = {'v': PROTOCOL, 'type': 'error', 'code': 'unreachable', 'message': message}
        sys.stdout.write(json.dumps(line, ensure_ascii=False) + '\n')
        sys.stdout.flush()

    return 3


def client_say(args: list[str]) -> int:
    """遠端的 `say`：`say [-v 語音] [文字…]`，沒給文字就讀 stdin。"""
    voice: str | None = None
    words: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        index += 1
        if arg in ('-v', '--voice'):
            if index >= len(args):
                sys.stderr.write('say: -v 後面要有語音名稱\n')

                return 2
            voice = args[index]
            index += 1
        elif arg.startswith('--voice='):
            voice = arg[len('--voice='):]
        elif arg == '--':
            words.extend(args[index:])
            break
        elif arg.startswith('-') and arg != '-':
            sys.stderr.write(f'say: 不支援的參數 {arg}（只支援 -v）\n')

            return 2
        else:
            words.append(arg)

    text = ' '.join(words) if words else sys.stdin.read()
    if text.strip() == '':
        return 0

    request: dict = {'v': PROTOCOL, 'cmd': 'say', 'text': text}
    if voice:
        request['voice'] = voice
    outcome = exchange(request)
    if isinstance(outcome, str):
        sys.stderr.write(f'say: {outcome}\n')

        return 1

    return outcome


# ── Mac：橋接 ─────────────────────────────────────────────────────────────


class Bridge:
    """接受 client 的請求，在這台 Mac 上執行 saymend CLI 或 `say`。"""

    def __init__(self, saymend_bin: str, say_bin: str, log=None) -> None:
        self.saymend_bin = saymend_bin
        self.say_bin = say_bin
        self.log = log or (lambda message: None)

    def plan(self, request: object) -> tuple[list[str], str | None, str] | str:
        """把請求變成 (argv, stdin 文字, 紀錄用的摘要)；不接受就回傳原因。

        摘要不含聽寫或朗讀的內容，只有指令名稱與字數。
        """
        if not isinstance(request, dict) or request.get('v') != PROTOCOL:
            return f'版本不符（這個橋接是 v{PROTOCOL}）：請重新執行 connect 更新遠端的 client'

        if request.get('cmd') == 'saymend':
            args = request.get('args')
            reason = validate_saymend_args(args)
            if reason is not None:
                return reason

            return [self.saymend_bin, *args], None, f'saymend {args[0]}'

        if request.get('cmd') == 'say':
            text = request.get('text')
            if not isinstance(text, str):
                return 'text 必須是字串'
            voice = request.get('voice')
            argv = [self.say_bin]
            if voice is not None:
                if not isinstance(voice, str) or VOICE.match(voice) is None or voice.startswith('-'):
                    return '語音名稱不合法'
                argv += ['-v', voice]
            text = text[:MAX_SAY_CHARS]

            # 文字走 stdin，不放進參數：開頭是「-」的文字才不會被當成 `say` 的選項
            return argv, text, f'say（{len(text)} 字）'

        return '不認得的 cmd'

    def handle(self, conn: socket.socket) -> None:
        try:
            request = read_request(conn)
            planned = self.plan(request)
            if isinstance(planned, str):
                self.log(f'拒絕：{planned}')
                send_frame(conn, {'err': f'saymend-remote: {planned}\n'})
                send_frame(conn, {'exit': 2})

                return
            argv, stdin_text, summary = planned
            outcome = run_child(conn, argv, stdin_text)
            self.log(f'{summary} → {outcome}')
        except Exception as error:  # noqa: BLE001  一條連線出錯不能拖垮整個橋接
            self.log(f'連線處理失敗：{error}')
        finally:
            conn.close()


def read_request(conn: socket.socket) -> object:
    """讀第一行當請求；10 秒內沒送完、太長或不是 JSON 都回 None。"""
    conn.settimeout(10)
    pending = b''
    try:
        while b'\n' not in pending:
            if len(pending) > MAX_REQUEST_BYTES:
                return None
            data = conn.recv(65536)
            if not data:
                return None
            pending += data
    except OSError:
        return None
    finally:
        conn.settimeout(None)
    try:
        return json.loads(pending.split(b'\n', 1)[0])
    except ValueError:
        return None


def run_child(conn: socket.socket, argv: list[str], stdin_text: str | None) -> str:
    """執行行程並把輸出串流回 client；client 離開就結束行程。回傳紀錄用的結果。"""
    try:
        child = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        send_frame(conn, {'err': f'saymend-remote: 無法執行 {argv[0]}：{error}\n'})
        send_frame(conn, {'exit': 1})

        return f'無法執行（{error}）'

    if stdin_text is not None:
        # 另開執行緒餵 stdin：文字比 pipe 緩衝大時，才不會卡住下面讀輸出的迴圈
        threading.Thread(target=feed_stdin, args=(child, stdin_text), daemon=True).start()

    assert child.stdout is not None and child.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'out')
    selector.register(child.stderr, selectors.EVENT_READ, 'err')
    selector.register(conn, selectors.EVENT_READ, 'conn')
    decoders = {
        'out': codecs.getincrementaldecoder('utf-8')('replace'),
        'err': codecs.getincrementaldecoder('utf-8')('replace'),
    }
    open_pipes = 2
    is_client_gone = False
    try:
        while open_pipes > 0 and not is_client_gone:
            for key, _ in selector.select():
                if key.data == 'conn':
                    try:
                        data = conn.recv(4096)
                    except OSError:
                        data = b''
                    if not data:
                        is_client_gone = True
                        break
                    continue
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    open_pipes -= 1
                    continue
                text = decoders[key.data].decode(chunk)
                if text and not send_frame(conn, {key.data: text}):
                    is_client_gone = True
                    break
    finally:
        selector.close()

    try:
        if is_client_gone:
            stop_child(child)

            return 'client 離開，已結束行程'

        code = child.wait()
        # 被 signal 結束的行程照 shell 的慣例回報 128+N
        code = code if code >= 0 else 128 - code
        send_frame(conn, {'exit': code})

        return f'exit {code}'
    finally:
        # 橋接是長駐行程：每個請求用過的 pipe 都要關，否則 fd 會越積越多
        child.stdout.close()
        child.stderr.close()


def feed_stdin(child: subprocess.Popen, text: str) -> None:
    assert child.stdin is not None
    try:
        child.stdin.write(text.encode('utf-8'))
        child.stdin.close()
    except OSError:
        pass


def stop_child(child: subprocess.Popen) -> None:
    """先 SIGTERM（saymend CLI 會請 app 取消並關麥克風），3 秒內沒結束就 SIGKILL。"""
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def serve(server: socket.socket, bridge: Bridge, stop: threading.Event) -> None:
    """accept 迴圈：一條連線一個執行緒，直到 stop 被設起來。"""
    server.settimeout(0.5)
    while not stop.is_set():
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=bridge.handle, args=(conn,), daemon=True).start()


def listen_on(path: Path) -> socket.socket:
    """在 path 開一個只有自己能連的 unix socket（0600）。"""
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.umask(0o177)
    try:
        server.bind(str(path))
    finally:
        os.umask(previous)
    server.listen(16)

    return server


# ── Mac：connect／uninstall ────────────────────────────────────────────────

# 遠端的安裝步驟。整段會包在 sh -c '…' 裡，所以內容不能出現單引號。
INSTALL_SCRIPT = (
    'set -e; d="$HOME/.saymend-remote"; mkdir -p "$d/bin"; chmod 700 "$d"; '
    'cat > "$d/saymend_remote.py.new"; mv "$d/saymend_remote.py.new" "$d/saymend_remote.py"; '
    'chmod 700 "$d/saymend_remote.py"; '
    'ln -sf ../saymend_remote.py "$d/bin/saymend"; ln -sf ../saymend_remote.py "$d/bin/say"; '
    # 上次留下的 socket 檔要先清掉，否則 sshd 沒辦法在同一個路徑重新建立
    'if [ -S "$d/bridge.sock" ]; then rm -f "$d/bridge.sock"; fi; '
    'if command -v python3 >/dev/null 2>&1; then echo "SAYMEND_REMOTE_HOME=$HOME"; '
    'else echo "SAYMEND_REMOTE_NOPYTHON"; fi'
)

UNINSTALL_SCRIPT = (
    'd="$HOME/.saymend-remote"; '
    'rm -f "$d/bin/saymend" "$d/bin/say" "$d/saymend_remote.py" "$d/saymend_remote.py.new" "$d/bridge.sock"; '
    'rmdir "$d/bin" "$d" 2>/dev/null; '
    'if [ -e "$d" ]; then echo "SAYMEND_REMOTE_LEFT=$d"; else echo "SAYMEND_REMOTE_REMOVED"; fi'
)

_print_lock = threading.Lock()


def say_line(message: str) -> None:
    """印一行帶時間的訊息（多個執行緒共用，所以上鎖）。"""
    with _print_lock:
        print(f'[{time.strftime("%H:%M:%S")}] {message}', flush=True)


def find_saymend(explicit: str | None) -> str | None:
    """找 Mac 上的 saymend CLI。"""
    candidates = [explicit] if explicit else [
        shutil.which('saymend'),
        str(Path.home() / '.local/bin/saymend'),
        '/Applications/Saymend.app/Contents/Helpers/saymend',
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    return None


def remove_dead_sockets(base: Path) -> None:
    """清掉之前的 connect 沒收乾淨的 socket（檔名帶著當時的 pid）。"""
    for leftover in base.glob('local-*.sock'):
        pid = leftover.stem.split('-', 1)[1]
        try:
            os.kill(int(pid), 0)
        except (ValueError, ProcessLookupError):
            leftover.unlink(missing_ok=True)
        except PermissionError:
            pass


class Link:
    """一台遠端主機：安裝 client、維持 `ssh -R` 轉發，斷線就重連。"""

    def __init__(self, host: str, local_socket: Path, stop: threading.Event) -> None:
        self.host = host
        self.local_socket = local_socket
        self.stop = stop
        self.tunnel: subprocess.Popen | None = None
        self.has_announced = False
        #: 重試也沒用的錯誤（例如遠端沒有 python3）：這一台不再重連
        self.is_fatal = False

    def install(self) -> str | None:
        """把這個檔案放到遠端，回傳遠端的家目錄；失敗回 None。"""
        try:
            ran = subprocess.run(
                ['ssh', self.host, f"sh -c '{INSTALL_SCRIPT}'"],
                input=Path(__file__).read_bytes(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            say_line(f'{self.host}：連不上（{error}）')

            return None
        output = ran.stdout.decode('utf-8', 'replace')
        if 'SAYMEND_REMOTE_NOPYTHON' in output:
            say_line(f'{self.host}：遠端沒有 python3，client 無法執行')
            self.is_fatal = True

            return None
        for line in output.splitlines():
            if line.startswith('SAYMEND_REMOTE_HOME='):
                return line.split('=', 1)[1].strip()
        detail = ran.stderr.decode('utf-8', 'replace').strip().splitlines()
        say_line(f'{self.host}：安裝 client 失敗（{detail[-1] if detail else f"ssh 結束碼 {ran.returncode}"}）')

        return None

    def check(self, home: str) -> str:
        """從遠端經橋接問一次 Saymend 的狀態，確認整條路是通的。"""
        client = f'{home}/{REMOTE_DIR}/bin/saymend'
        for _ in range(5):
            if self.stop.is_set() or (self.tunnel is not None and self.tunnel.poll() is not None):
                break
            try:
                ran = subprocess.run(
                    ['ssh', self.host, client, 'status', '--json'],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                    check=False,
                )
                status = json.loads(ran.stdout.decode('utf-8', 'replace').strip().splitlines()[0])
            except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
                status = {}
            if status.get('app') == 'running':
                return f'Saymend：{status.get("state", "未知")}'
            if status.get('app') == 'not_running' and 'message' not in status:
                return 'Saymend.app 沒有在執行，先把它打開'
            self.stop.wait(1)

        return '轉發沒有建立起來'

    def announce(self, home: str, state: str) -> None:
        if self.has_announced:
            say_line(f'{self.host}：已重新連上（{state}）')

            return
        self.has_announced = True
        with _print_lock:
            print(
                f'\n已連上 {self.host}（{state}）。\n'
                f'在那台機器的 Claude Code 裡執行一次，設定會留著：\n\n'
                f'  /saymend bin {home}/{REMOTE_DIR}/bin/saymend\n'
                f'  /saymend speaker {home}/{REMOTE_DIR}/bin/say\n\n'
                f'這個視窗要一直開著；按 Ctrl-C 結束橋接。\n',
                flush=True,
            )

    def run(self) -> None:
        delay = 2.0
        while not self.stop.is_set():
            home = self.install()
            if home is not None:
                started = time.monotonic()
                self.tunnel = subprocess.Popen(
                    [
                        'ssh', '-N', '-T',
                        '-o', 'ExitOnForwardFailure=yes',
                        '-o', 'ServerAliveInterval=15',
                        '-o', 'ServerAliveCountMax=3',
                        '-R', f'{home}/{REMOTE_DIR}/{SOCKET_NAME}:{self.local_socket}',
                        self.host,
                    ],
                    stdin=subprocess.DEVNULL,
                )
                state = self.check(home)
                if self.tunnel.poll() is None:
                    self.announce(home, state)
                code = self.tunnel.wait()
                lasted = time.monotonic() - started
                if lasted > 60:
                    delay = 2.0
                elif not self.stop.is_set() and not self.has_announced and code != 0:
                    # 一次都沒連上就結束：多半是遠端的 sshd 不允許轉發，ssh 自己的錯誤訊息在上面
                    say_line(f'{self.host}：SSH 轉發沒有建立（ssh 結束碼 {code}）。請確認遠端的 sshd 允許轉發')
            if self.stop.is_set() or self.is_fatal:
                break
            say_line(f'{self.host}：連線中斷，{delay:.0f} 秒後重連')
            self.stop.wait(delay)
            delay = min(delay * 2, 30.0)

    def close(self) -> None:
        if self.tunnel is not None and self.tunnel.poll() is None:
            self.tunnel.terminate()


def command_connect(hosts: list[str], saymend_arg: str | None) -> int:
    saymend_bin = find_saymend(saymend_arg)
    if saymend_bin is None:
        print('找不到 saymend CLI。請確認 Saymend 已安裝，或用 --saymend 指定路徑。', file=sys.stderr)

        return 1
    say_bin = shutil.which('say')
    if say_bin is None:
        print('找不到 `say`：橋接要在 macOS 上執行。', file=sys.stderr)

        return 1

    base = Path.home() / REMOTE_DIR
    base.mkdir(mode=0o700, exist_ok=True)
    base.chmod(0o700)
    remove_dead_sockets(base)
    local_socket = base / f'local-{os.getpid()}.sock'
    local_socket.unlink(missing_ok=True)
    server = listen_on(local_socket)

    stop = threading.Event()
    bridge = Bridge(saymend_bin, say_bin, log=say_line)
    threading.Thread(target=serve, args=(server, bridge, stop), daemon=True).start()
    links = [Link(host, local_socket, stop) for host in hosts]
    threads = [threading.Thread(target=link.run, daemon=True) for link in links]

    def on_signal(_signum, _frame) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)
    say_line(f'橋接已啟動（saymend：{saymend_bin}）')
    try:
        for thread in threads:
            thread.start()
        while not stop.is_set() and any(thread.is_alive() for thread in threads):
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for link in links:
            link.close()
        server.close()
        local_socket.unlink(missing_ok=True)
    say_line('橋接已結束')

    return 0


def command_uninstall(hosts: list[str]) -> int:
    failed = 0
    for host in hosts:
        ran = subprocess.run(
            ['ssh', host, f"sh -c '{UNINSTALL_SCRIPT}'"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        output = ran.stdout.decode('utf-8', 'replace')
        if 'SAYMEND_REMOTE_REMOVED' in output:
            print(f'{host}：已移除 ~/{REMOTE_DIR}')
        elif 'SAYMEND_REMOTE_LEFT=' in output:
            print(f'{host}：已移除 client，但 ~/{REMOTE_DIR} 裡還有其他檔案，資料夾沒有刪')
        else:
            failed += 1
            print(f'{host}：移除失敗（ssh 結束碼 {ran.returncode}）', file=sys.stderr)

    return 1 if failed else 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')

    # 被叫成 saymend／say（遠端的 symlink）＝ client
    name = os.path.basename(sys.argv[0])
    try:
        if name == 'saymend':
            return client_saymend(sys.argv[1:])
        if name == 'say':
            return client_say(sys.argv[1:])
    except KeyboardInterrupt:
        # 與 saymend CLI 收到 SIGINT 相同：取消，exit 5（連線關閉時橋接會取消那段聽寫）
        return 5
    except BrokenPipeError:
        return 1

    parser = argparse.ArgumentParser(
        prog='saymend-remote',
        description='讓遠端主機上的 saymend-voice mod 使用這台 Mac 的 Saymend 與喇叭。',
    )
    commands = parser.add_subparsers(dest='command', required=True)
    connect = commands.add_parser('connect', help='啟動橋接並連到遠端主機（在 Mac 上執行，保持開著）')
    connect.add_argument('hosts', nargs='+', metavar='ssh主機', help='ssh 連得上的主機，寫法同 ssh（例如 user@host）')
    connect.add_argument('--saymend', metavar='路徑', help='Mac 上 saymend CLI 的路徑（預設自動尋找）')
    uninstall = commands.add_parser('uninstall', help='移除遠端主機上的 client')
    uninstall.add_argument('hosts', nargs='+', metavar='ssh主機')
    options = parser.parse_args()

    if options.command == 'connect':
        return command_connect(options.hosts, options.saymend)

    return command_uninstall(options.hosts)


if __name__ == '__main__':
    sys.exit(main())
