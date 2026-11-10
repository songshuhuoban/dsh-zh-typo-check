"""User-authorized native keyboard/IME batch recorder for Windows Notepad.

Letters use SendInput scan codes, never paste/Unicode text injection. Text is
read from the visible RichEdit via WM_GETTEXT. One Space per sample, then an
Escape comparison detects remaining composition. Only a dedicated scratch tab
is edited; changing focus/title or holding physical Escape aborts the batch.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
U = C.WinDLL('user32', use_last_error=True)
IMM = C.WinDLL('imm32', use_last_error=True)
KERNEL = C.WinDLL('kernel32', use_last_error=True)
KERNEL.GetCurrentThreadId.argtypes, KERNEL.GetCurrentThreadId.restype = [], W.DWORD
CALLBACK = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)


class Mouse(C.Structure):
    _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('data', W.DWORD),
                ('flags', W.DWORD), ('time', W.DWORD), ('extra', C.c_size_t)]


class Keyboard(C.Structure):
    _fields_ = [('vk', W.WORD), ('scan', W.WORD), ('flags', W.DWORD),
                ('time', W.DWORD), ('extra', C.c_size_t)]


class Hardware(C.Structure):
    _fields_ = [('message', W.DWORD), ('low', W.WORD), ('high', W.WORD)]


class InputUnion(C.Union):
    _fields_ = [('mouse', Mouse), ('keyboard', Keyboard), ('hardware', Hardware)]


class Input(C.Structure):
    _fields_ = [('type', W.DWORD), ('u', InputUnion)]


class GuiInfo(C.Structure):
    _fields_ = [('size', W.DWORD), ('flags', W.DWORD),
                ('active', W.HWND), ('focus', W.HWND), ('capture', W.HWND),
                ('menu', W.HWND), ('move', W.HWND), ('caret', W.HWND),
                ('rect', W.RECT)]


def bind(name, args, result):
    f = getattr(U, name)
    f.argtypes, f.restype = args, result
    return f


bind('EnumWindows', [CALLBACK, W.LPARAM], W.BOOL)
bind('EnumChildWindows', [W.HWND, CALLBACK, W.LPARAM], W.BOOL)
bind('GetWindowTextW', [W.HWND, W.LPWSTR, C.c_int], C.c_int)
bind('GetClassNameW', [W.HWND, W.LPWSTR, C.c_int], C.c_int)
bind('IsWindowVisible', [W.HWND], W.BOOL)
bind('GetWindowThreadProcessId', [W.HWND, C.POINTER(W.DWORD)], W.DWORD)
bind('SendMessageTimeoutW', [W.HWND, W.UINT, W.WPARAM, W.LPARAM,
                           W.UINT, W.UINT, C.POINTER(C.c_size_t)], W.LPARAM)
bind('SendInput', [W.UINT, C.POINTER(Input), C.c_int], W.UINT)
bind('MapVirtualKeyW', [W.UINT, W.UINT], W.UINT)
bind('GetForegroundWindow', [], W.HWND)
bind('SetForegroundWindow', [W.HWND], W.BOOL)
bind('AttachThreadInput', [W.DWORD, W.DWORD, W.BOOL], W.BOOL)
bind('BringWindowToTop', [W.HWND], W.BOOL)
bind('SetFocus', [W.HWND], W.HWND)
bind('ShowWindow', [W.HWND, C.c_int], W.BOOL)
bind('GetAsyncKeyState', [C.c_int], W.SHORT)
bind('GetGUIThreadInfo', [W.DWORD, C.POINTER(GuiInfo)], W.BOOL)
bind('GetKeyboardLayout', [W.DWORD], W.HANDLE)
IMM.ImmGetContext.argtypes, IMM.ImmGetContext.restype = [W.HWND], W.HANDLE
IMM.ImmReleaseContext.argtypes = [W.HWND, W.HANDLE]
IMM.ImmGetCompositionStringW.argtypes = [W.HANDLE, W.DWORD, W.LPVOID, W.DWORD]
IMM.ImmGetCompositionStringW.restype = W.LONG


def now():
    return datetime.now(timezone.utc).isoformat()


def window_string(hwnd, function):
    buf = C.create_unicode_buffer(2048)
    function(hwnd, buf, len(buf))
    return buf.value


def enumerate_windows(parent=None):
    found = []
    @CALLBACK
    def callback(hwnd, _):
        found.append(hwnd)
        return True
    if parent is None:
        U.EnumWindows(callback, 0)
    else:
        U.EnumChildWindows(parent, callback, 0)
    return found


def text(hwnd):
    n = C.c_size_t()
    if not U.SendMessageTimeoutW(hwnd, 0xE, 0, 0, 2, 1000, C.byref(n)):
        raise RuntimeError('WM_GETTEXTLENGTH failed')
    if n.value > 20000:
        raise RuntimeError('Unexpectedly long scratch document; stop')
    buf = C.create_unicode_buffer(n.value + 1)
    count = C.c_size_t()
    if not U.SendMessageTimeoutW(hwnd, 0xD, len(buf), C.cast(buf, C.c_void_p).value,
                                 2, 1000, C.byref(count)):
        raise RuntimeError('WM_GETTEXT failed')
    return buf.value


def composition(hwnd):
    ctx = IMM.ImmGetContext(hwnd)
    if not ctx:
        return None
    try:
        size = IMM.ImmGetCompositionStringW(ctx, 8, None, 0)
        if size < 0:
            return None
        if not size:
            return ''
        buf = C.create_string_buffer(size + 2)
        result = IMM.ImmGetCompositionStringW(ctx, 8, buf, size)
        return buf.raw[:max(0, result)].decode('utf-16-le')
    finally:
        IMM.ImmReleaseContext(hwnd, ctx)


class Recorder:
    def __init__(self, scratch, owned_before):
        self.scratch = scratch
        subprocess.Popen([str(Path(os.environ['SystemRoot'])/'System32/notepad.exe'), str(scratch)])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            candidates = [h for h in enumerate_windows()
                          if scratch.name in window_string(h, U.GetWindowTextW)
                          and window_string(h, U.GetClassNameW) == 'Notepad']
            if len(candidates) == 1:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('Dedicated scratch tab did not expose exactly one Notepad window')
        self.main = candidates[0]
        U.ShowWindow(self.main, 9)
        U.SetForegroundWindow(self.main)
        time.sleep(.4)
        editors = [h for h in enumerate_windows(self.main) if U.IsWindowVisible(h)
                   and 'RichEdit' in window_string(h, U.GetClassNameW)]
        if len(editors) != 1:
            raise RuntimeError(f'Expected one visible RichEdit, got {len(editors)}')
        self.editor = editors[0]
        self.thread = U.GetWindowThreadProcessId(self.editor, None)
        self.activation_method = 'SetForegroundWindow'
        if U.GetForegroundWindow() != self.main:
            self.activate_owned()
        self.guard()
        if text(self.editor) and not owned_before:
            raise RuntimeError('New scratch document is not empty; refusing to edit')
        self.clear()

    def activate_owned(self):
        """One startup focus attempt on our scratch, detached before sampling.

        Never called to recover lost focus in the middle of a batch. No keys
        are sent to acquire activation, and a locked desktop is refused.
        """
        foreground = U.GetForegroundWindow()
        title = window_string(foreground, U.GetWindowTextW) if foreground else ''
        if not foreground or '锁屏' in title or 'Lock Screen' in title:
            raise RuntimeError('Desktop locked/unavailable; unlock before resuming')
        if self.scratch.name not in window_string(self.main, U.GetWindowTextW):
            raise RuntimeError('Owned scratch tab changed before activation')
        if any(U.GetAsyncKeyState(v) & 0x8000 for v in [0x1B,0x10,0x11,0x12]):
            raise RuntimeError('Physical Escape/modifier held; refusing activation')
        current = KERNEL.GetCurrentThreadId()
        fore_thread = U.GetWindowThreadProcessId(foreground, None)
        joined = []
        try:
            for thread in dict.fromkeys([fore_thread,self.thread]):
                if thread == current:
                    continue
                if not thread or not U.AttachThreadInput(current, thread, True):
                    raise RuntimeError('Cannot attach input threads for owned scratch activation')
                joined.append(thread)
            U.BringWindowToTop(self.main)
            U.SetForegroundWindow(self.main)
            if U.GetForegroundWindow() == self.main:
                U.SetFocus(self.editor)
        finally:
            for thread in reversed(joined):
                U.AttachThreadInput(current, thread, False)
        time.sleep(.4)
        self.activation_method = 'One startup AttachThreadInput focus; detached before sampling'

    def guard(self):
        if U.GetAsyncKeyState(0x1B) & 0x8000:
            raise RuntimeError('Physical Escape pressed; capture stopped')
        if U.GetForegroundWindow() != self.main:
            raise RuntimeError('Foreground changed; capture stopped before sending more keys')
        if self.scratch.name not in window_string(self.main, U.GetWindowTextW):
            raise RuntimeError('Active Notepad tab changed; capture stopped')
        info = GuiInfo(); info.size = C.sizeof(info)
        if not U.GetGUIThreadInfo(self.thread, C.byref(info)) or info.focus != self.editor:
            raise RuntimeError('Editor focus changed; capture stopped')

    def raw_key(self, vk, up=False):
        event = Input(type=1, u=InputUnion(keyboard=Keyboard(
            vk=0, scan=U.MapVirtualKeyW(vk, 0), flags=8 | (2 if up else 0), time=0, extra=0)))
        if U.SendInput(1, C.byref(event), C.sizeof(Input)) != 1:
            raise C.WinError(C.get_last_error())

    def key(self, vk):
        self.guard()
        if any(U.GetAsyncKeyState(v) & 0x8000 for v in [0x10, 0x11, 0x12]):
            raise RuntimeError('A modifier is held; refusing to type')
        self.raw_key(vk)
        self.raw_key(vk, True)

    def chord(self, modifier, vk):
        self.guard()
        self.raw_key(modifier)
        try:
            self.raw_key(vk)
            self.raw_key(vk, True)
        finally:
            self.raw_key(modifier, True)

    def clear(self):
        self.key(0x1B)
        time.sleep(.04)
        self.chord(0x11, ord('A'))
        time.sleep(.04)
        self.key(8)
        time.sleep(.07)
        if text(self.editor):
            raise RuntimeError('Scratch field did not clear; stop rather than repeat input')

    def collect(self, keys, delay, settle):
        self.clear()
        for char in keys:
            self.key({'[': 0xDB, ';': 0xBA}.get(char, ord(char.upper())))
            time.sleep(delay)
        time.sleep(.12)
        before, comp_before = text(self.editor), composition(self.editor)
        self.key(0x20)  # exactly one Space
        time.sleep(settle)
        self.guard()
        after, comp_after = text(self.editor), composition(self.editor)
        self.key(0x1B)  # only after recording: detect/cancel remaining composition
        time.sleep(.12)
        cancelled = text(self.editor)
        return {'text_before_space': before, 'imm_composition_before': comp_before,
                'actual_output_after_one_space': after, 'imm_composition_after': comp_after,
                'text_after_cancel': cancelled, 'pending_composition_detected': after != cancelled,
                'pending_detection': 'Difference after Escape; IMM strings also preserved (TSF may not expose them).'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--batch', type=Path, default=ROOT/'data/ime-keyboard/batch-001.json')
    p.add_argument('--output', type=Path, default=ROOT/'data/ime-keyboard/notepad-batch-001.jsonl')
    p.add_argument('--limit', type=int)
    p.add_argument('--resume', action='store_true')
    p.add_argument('--delay-ms', type=int, default=60)
    p.add_argument('--settle-ms', type=int, default=700)
    args = p.parse_args()
    if not 20 <= args.delay_ms <= 1000 or not 500 <= args.settle_ms <= 10000:
        raise ValueError('Choose a measured, nonzero keyboard/IME delay')
    batch_bytes = args.batch.read_bytes()
    batch = json.loads(batch_bytes)
    rows = batch['rows'][:args.limit] if args.limit else batch['rows']
    if any(not re.fullmatch(r'[a-z\[;]+', r['keys']) for r in rows):
        raise ValueError('Only the bounded letter/punctuation alphabet is allowed')
    source_hash = hashlib.sha256(batch_bytes).hexdigest()
    prior = []
    if args.output.exists():
        if not args.resume:
            raise FileExistsError('Capture exists; use --resume or a new output file')
        prior = [json.loads(line) for line in args.output.read_text(encoding='utf-8').splitlines()]
        if any(row['source_batch_sha256'] != source_hash for row in prior):
            raise ValueError('Resume batch hash mismatch')
    completed = {row['id'] for row in prior}
    if len(completed) != len(prior):
        raise ValueError('Duplicate captured IDs')
    todo = [r for r in rows if r['id'] not in completed]
    if not todo:
        print('No uncaptured rows', flush=True)
        return
    work = ROOT/'.research/ime-keyboard'
    work.mkdir(parents=True, exist_ok=True)
    scratch = work/(args.output.stem + '.scratch.txt')
    if scratch.exists() and not args.resume:
        raise FileExistsError('Scratch path already exists; use --resume or a new output')
    if not scratch.exists():
        scratch.touch(exist_ok=False)
    started = now()
    recorder = Recorder(scratch.resolve(), owned_before=args.resume)
    probe = recorder.collect('nihao', args.delay_ms/1000, args.settle_ms/1000)
    if not re.search('[\u4e00-\u9fff]', probe['actual_output_after_one_space']):
        raise RuntimeError('nihao probe did not produce Chinese; refusing a non-IME batch')
    manifest = {'started_at': started, 'source_batch_sha256':source_hash,
                'source_entropy_sha256':batch['entropy']['raw_sha256'], 'probe':probe,
                'hkl':hex(U.GetKeyboardLayout(recorder.thread)), 'delay_ms':args.delay_ms,
                'activation_method':recorder.activation_method,
                'recorder_code_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'settle_ms':args.settle_ms, 'scratch':scratch.name,
                'method':'Native SendInput scan codes; exactly one Space; visible RichEdit WM_GETTEXT; Escape comparison after snapshot.',
                'user_authorization':'2026-11-09: use a script rather than Computer Use for batch typing; assistant labels outputs.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path = work/(args.output.stem + '-run-' + started.replace(':','').replace('.','') + '.json')
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'probe':probe,'todo':len(todo),'source_batch_sha256':source_hash},ensure_ascii=False),flush=True)
    try:
        for row in todo:
            record = {**row, **recorder.collect(row['keys'], args.delay_ms/1000, args.settle_ms/1000),
                      'captured_at':now(),'source_batch_sha256':source_hash,
                      'capture_method':'native-notepad-script','inter_key_delay_ms':args.delay_ms,
                      'post_space_wait_ms':args.settle_ms}
            with args.output.open('a', encoding='utf-8') as f:
                f.write(json.dumps(record,ensure_ascii=False)+'\n')
                f.flush(); os.fsync(f.fileno())
            print(json.dumps({'id':row['id'],'output':record['actual_output_after_one_space'],
                              'pending':record['pending_composition_detected']},ensure_ascii=False),flush=True)
    finally:
        manifest['ended_at'] = now()
        manifest['captured_total'] = len(args.output.read_text(encoding='utf-8').splitlines()) if args.output.exists() else 0
        manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


if __name__ == '__main__':
    if hasattr(__import__('sys').stdout,'reconfigure'):
        __import__('sys').stdout.reconfigure(encoding='utf-8')
    main()
