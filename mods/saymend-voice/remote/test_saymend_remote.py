"""saymend_remote.py 的測試：不經 SSH，直接讓 client 連本機的橋接 socket。

Mac 上的 saymend CLI 與 `say` 用假的 shell script 代替，所以不會真的開麥或發聲。
執行：python3 -m unittest discover -s mods/saymend-voice/remote -p 'test_*.py'
"""

from __future__ import annotations

import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import saymend_remote  # noqa: E402

SCRIPT = HERE / 'saymend_remote.py'

FAKE_SAYMEND = """#!/bin/sh
# 假的 saymend CLI：記下收到的參數，依子指令回固定的輸出
echo "$@" >> "$FAKE_DIR/saymend.args"
case "$1" in
  status) echo '{"v":1,"app":"running","state":"idle","source":null,"modelReady":true}' ;;
  dictate)
    echo '{"v":1,"type":"started"}'
    echo '{"v":1,"type":"final","text":"今天天氣很好。"}'
    echo 'saymend: 人讀的訊息' >&2
    ;;
  events)
    # 長駐串流：收到 SIGTERM 就留下記號再結束（模擬 CLI 的取消）
    trap 'echo cancelled > "$FAKE_DIR/cancelled"; exit 5' TERM
    echo '{"v":1,"type":"state","state":"idle","source":null}'
    while :; do sleep 0.1; done
    ;;
  stop) exit 4 ;;
esac
"""

FAKE_SAY = """#!/bin/sh
# 假的 say：記下參數與 stdin 的文字
echo "$@" > "$FAKE_DIR/say.args"
cat > "$FAKE_DIR/say.text"
"""


def wait_for(path: Path, seconds: float = 5.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(0.05)

    return False


class ValidateArgs(unittest.TestCase):
    def test_放行_mod_會用到的指令(self) -> None:
        for args in (
            ['status', '--json'],
            ['events', '--json'],
            ['cancel'],
            ['stop', '--json'],
            ['--version'],
            ['dictate', '--json', '--silence-ms', '1500', '--max-seconds', '120'],
            ['dictate', '--json', '--no-speech-seconds=10', '--polish'],
            ['dictate', '--max-seconds', '0.5'],
        ):
            self.assertIsNone(saymend_remote.validate_saymend_args(args), args)

    def test_拒絕其他子指令與參數(self) -> None:
        for args in (
            [],
            ['open', '/etc/passwd'],
            ['dictate', '--output', '/tmp/x'],
            ['dictate', '--silence-ms'],
            ['dictate', '--silence-ms', 'abc'],
            ['dictate', '--max-seconds=-1'],
            ['status', '--polish'],
            ['status', '--max-seconds', '3'],
            'status',
            ['status', 1],
        ):
            self.assertIsNotNone(saymend_remote.validate_saymend_args(args), args)


class RemoteInstall(unittest.TestCase):
    """遠端的安裝／移除步驟：在假的家目錄裡直接用 sh 執行，不經 SSH。"""

    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix='sr-home-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.home, True)

    def sh(self, script: str, stdin: bytes = b'') -> str:
        ran = subprocess.run(
            ['sh', '-c', script],
            input=stdin,
            capture_output=True,
            env={'HOME': str(self.home), 'PATH': os.environ['PATH']},
            timeout=20,
            check=True,
        )

        return ran.stdout.decode()

    def test_安裝後有_client_與兩個_symlink_並清掉舊的_socket(self) -> None:
        base = self.home / '.saymend-remote'
        base.mkdir()
        stale = saymend_remote.listen_on(base / 'bridge.sock')
        stale.close()
        self.assertTrue((base / 'bridge.sock').exists())

        output = self.sh(saymend_remote.INSTALL_SCRIPT, SCRIPT.read_bytes())

        self.assertIn(f'SAYMEND_REMOTE_HOME={self.home}', output)
        self.assertEqual(stat.S_IMODE(base.stat().st_mode), 0o700)
        self.assertEqual((base / 'saymend_remote.py').read_bytes(), SCRIPT.read_bytes())
        self.assertFalse((base / 'bridge.sock').exists())
        for name in ('saymend', 'say'):
            self.assertEqual(os.readlink(base / 'bin' / name), '../saymend_remote.py')
        # 裝好的 client 真的能執行（這裡沒有橋接，所以回報連不上）
        ran = subprocess.run(
            [str(base / 'bin' / 'saymend'), 'status', '--json'],
            capture_output=True,
            text=True,
            env={'HOME': str(self.home), 'PATH': os.environ['PATH']},
            timeout=20,
            check=False,
        )
        self.assertEqual(ran.returncode, 3)
        self.assertIn('not_running', ran.stdout)

    def test_移除後不留資料夾_有別的檔案時保留資料夾(self) -> None:
        self.sh(saymend_remote.INSTALL_SCRIPT, SCRIPT.read_bytes())
        self.assertIn('SAYMEND_REMOTE_REMOVED', self.sh(saymend_remote.UNINSTALL_SCRIPT))
        self.assertFalse((self.home / '.saymend-remote').exists())

        self.sh(saymend_remote.INSTALL_SCRIPT, SCRIPT.read_bytes())
        (self.home / '.saymend-remote' / 'mine.txt').write_text('使用者自己的檔案')
        self.assertIn('SAYMEND_REMOTE_LEFT=', self.sh(saymend_remote.UNINSTALL_SCRIPT))
        self.assertTrue((self.home / '.saymend-remote' / 'mine.txt').exists())


class BridgeEndToEnd(unittest.TestCase):
    """真的開 socket、真的執行 client 行程（透過 symlink，跟遠端的安裝方式一樣）。"""

    def setUp(self) -> None:
        # unix socket 路徑有長度上限，所以放在短路徑的暫存目錄
        self.dir = Path(tempfile.mkdtemp(prefix='sr-', dir='/tmp'))
        self.addCleanup(shutil.rmtree, self.dir, True)

        for name, body in (('fake-saymend', FAKE_SAYMEND), ('fake-say', FAKE_SAY)):
            path = self.dir / name
            path.write_text(body)
            path.chmod(0o755)
        (self.dir / 'bin').mkdir()
        for name in ('saymend', 'say'):
            (self.dir / 'bin' / name).symlink_to(SCRIPT)

        self.socket_path = self.dir / 'bridge.sock'
        self.logs: list[str] = []
        self.stop = threading.Event()
        os.environ['FAKE_DIR'] = str(self.dir)
        self.addCleanup(os.environ.pop, 'FAKE_DIR', None)
        self.server = saymend_remote.listen_on(self.socket_path)
        bridge = saymend_remote.Bridge(
            str(self.dir / 'fake-saymend'), str(self.dir / 'fake-say'), log=self.logs.append
        )
        self.thread = threading.Thread(
            target=saymend_remote.serve, args=(self.server, bridge, self.stop), daemon=True
        )
        self.thread.start()
        self.addCleanup(self.shutdown)

    def shutdown(self) -> None:
        self.stop.set()
        self.server.close()
        self.thread.join(timeout=2)

    def client(self, name: str, *args: str, stdin: str | None = None, socket_path: Path | None = None):
        env = {**os.environ, saymend_remote.SOCKET_ENV: str(socket_path or self.socket_path)}

        return subprocess.run(
            [str(self.dir / 'bin' / name), *args],
            input=stdin,
            capture_output=True,
            text=True,
            env=env,
            timeout=20,
            check=False,
        )

    def test_socket_只有自己能連(self) -> None:
        mode = stat.S_IMODE(self.socket_path.stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_saymend_的輸出與結束碼原樣帶回(self) -> None:
        ran = self.client('saymend', 'dictate', '--json', '--silence-ms', '1500')

        self.assertEqual(ran.returncode, 0)
        self.assertEqual(
            ran.stdout.splitlines(),
            ['{"v":1,"type":"started"}', '{"v":1,"type":"final","text":"今天天氣很好。"}'],
        )
        self.assertEqual(ran.stderr, 'saymend: 人讀的訊息\n')
        self.assertEqual(
            (self.dir / 'saymend.args').read_text().strip(), 'dictate --json --silence-ms 1500'
        )

        self.assertEqual(self.client('saymend', 'stop').returncode, 4)

    def test_紀錄不含聽寫與朗讀的內容(self) -> None:
        self.client('saymend', 'dictate', '--json')
        self.client('say', stdin='不可以出現在紀錄裡')
        deadline = time.monotonic() + 3
        while len(self.logs) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)

        self.assertEqual(self.logs, ['saymend dictate → exit 0', 'say（9 字） → exit 0'])

    def test_不在白名單的參數不會執行(self) -> None:
        ran = self.client('saymend', 'dictate', '--output', '/tmp/x')

        self.assertEqual(ran.returncode, 2)
        self.assertIn('不接受的參數', ran.stderr)
        self.assertFalse((self.dir / 'saymend.args').exists())

    def test_say_文字走_stdin_語音走參數(self) -> None:
        ran = self.client('say', '-v', 'Meijia', stdin='-f 開頭像選項的文字\n第二行')

        self.assertEqual(ran.returncode, 0)
        self.assertEqual((self.dir / 'say.args').read_text().strip(), '-v Meijia')
        self.assertEqual((self.dir / 'say.text').read_text(), '-f 開頭像選項的文字\n第二行')

    def test_say_也能把文字寫在參數裡(self) -> None:
        ran = self.client('say', '測試', '一下')

        self.assertEqual(ran.returncode, 0)
        self.assertEqual((self.dir / 'say.args').read_text().strip(), '')
        self.assertEqual((self.dir / 'say.text').read_text(), '測試 一下')

    def test_say_拒絕不合法的語音名稱(self) -> None:
        ran = self.client('say', '-v', '-o/tmp/x.aiff', stdin='測試')

        self.assertEqual(ran.returncode, 2)
        self.assertFalse((self.dir / 'say.text').exists())

    def test_client_被結束時_Mac_上的行程也會結束(self) -> None:
        env = {**os.environ, saymend_remote.SOCKET_ENV: str(self.socket_path)}
        client = subprocess.Popen(
            [str(self.dir / 'bin' / 'saymend'), 'events', '--json'],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        assert client.stdout is not None
        # 第一行到了＝Mac 上的行程已經在跑
        self.assertIn(b'"state":"idle"', client.stdout.readline())

        client.send_signal(signal.SIGTERM)
        client.wait(timeout=5)
        client.stdout.close()

        self.assertTrue(wait_for(self.dir / 'cancelled'), '橋接沒有結束 Mac 上的行程')

    def test_連不上橋接時照_CLI_契約回報(self) -> None:
        nowhere = self.dir / 'nowhere.sock'

        status = self.client('saymend', 'status', '--json', socket_path=nowhere)
        self.assertEqual(status.returncode, 3)
        self.assertIn('"app": "not_running"', status.stdout)
        self.assertIn('連不上 Mac', status.stdout)

        dictate = self.client('saymend', 'dictate', '--json', socket_path=nowhere)
        self.assertEqual(dictate.returncode, 3)
        self.assertIn('"code": "unreachable"', dictate.stdout)

        say = self.client('say', stdin='測試', socket_path=nowhere)
        self.assertEqual(say.returncode, 1)
        self.assertIn('連不上 Mac', say.stderr)

    def test_版本不符的請求會被拒絕(self) -> None:
        bridge = saymend_remote.Bridge('saymend', 'say')

        self.assertIsInstance(bridge.plan({'v': 99, 'cmd': 'saymend', 'args': ['status']}), str)
        self.assertIsInstance(bridge.plan({'v': 1, 'cmd': 'shell', 'args': ['ls']}), str)
        self.assertIsInstance(bridge.plan('不是物件'), str)


if __name__ == '__main__':
    unittest.main()
